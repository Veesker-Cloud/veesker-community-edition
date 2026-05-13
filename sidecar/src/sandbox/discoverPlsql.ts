export type ObjectKind = "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE" | "VIEW";

export interface DependencyEdge {
  name: string;
  type: string;
  referencedName: string;
  referencedOwner: string;
  referencedType: string;
}

export interface DiscoveredObject {
  kind: ObjectKind;
  owner: string;
  name: string;
  refPath: string[];
}

export interface DiscoveredDependency {
  kind: ObjectKind;
  owner: string;
  name: string;
  refKind: string;
  refOwner: string;
  refName: string;
  refStatus: "INCLUDED" | "EXCLUDED" | "OUTSIDE_SCHEMA";
}

export interface DiscoverPlsqlResult {
  objects: DiscoveredObject[];
  dependencies: DiscoveredDependency[];
}

export type DepWalkFn = (
  owner: string,
  referencedNames: string[],
) => Promise<DependencyEdge[]>;

const MAX_DEPTH = 5;

const KIND_ORDER: ObjectKind[] = ["TYPE", "PACKAGE", "PROCEDURE", "FUNCTION", "TRIGGER", "VIEW"];

function normalizeKind(rawType: string): ObjectKind | null {
  const t = rawType.toUpperCase();
  if (t === "PACKAGE BODY") return "PACKAGE";
  if (KIND_ORDER.includes(t as ObjectKind)) return t as ObjectKind;
  return null;
}

export async function discoverPlsql(
  walk: DepWalkFn,
  schema: string,
  rootTableNames: string[],
): Promise<DiscoverPlsqlResult> {
  const schemaUpper = schema.toUpperCase();
  const rootSet = new Set(rootTableNames.map((n) => n.toUpperCase()));

  // The frontier carries "referenced" names; objects whose dependents we
  // discover at the NEXT depth are the dependents found here. Starting with
  // root tables seeds depth-1 with the user-selected table set.
  let frontier: Set<string> = new Set(rootSet);
  const discovered: Map<string, DiscoveredObject> = new Map();
  const dependencies: DiscoveredDependency[] = [];
  // Edge dedup: the same (name, refOwner, refName) triple may surface across
  // multiple BFS rounds when a dependent reaches a referenced object via more
  // than one path. Without this guard, downstream consumers of __vsk_dependencies
  // would see phantom duplicates.
  const seenEdges: Set<string> = new Set();
  const refPaths: Map<string, string[]> = new Map();
  for (const t of rootSet) refPaths.set(`${schemaUpper}.${t}`, [t]);

  for (let depth = 1; depth <= MAX_DEPTH && frontier.size > 0; depth++) {
    const edges = await walk(schemaUpper, [...frontier]);
    const nextFrontier: Set<string> = new Set();

    for (const e of edges) {
      const kind = normalizeKind(e.type);
      if (!kind) continue;

      const key = `${schemaUpper}.${e.name.toUpperCase()}`;
      if (!discovered.has(key)) {
        const parentPath = refPaths.get(`${e.referencedOwner.toUpperCase()}.${e.referencedName.toUpperCase()}`) ?? [];
        const path = [...parentPath, e.name.toUpperCase()];
        refPaths.set(key, path);
        discovered.set(key, { kind, owner: schemaUpper, name: e.name.toUpperCase(), refPath: path });
        nextFrontier.add(e.name.toUpperCase());
      }
    }

    for (const e of edges) {
      const kind = normalizeKind(e.type);
      if (!kind) continue;
      const nameU = e.name.toUpperCase();
      const refOwnerU = e.referencedOwner.toUpperCase();
      const refNameU = e.referencedName.toUpperCase();
      const sig = `${nameU}\x00${refOwnerU}\x00${refNameU}`;
      if (seenEdges.has(sig)) continue;
      seenEdges.add(sig);
      dependencies.push({
        kind,
        owner: schemaUpper,
        name: nameU,
        refKind: e.referencedType.toUpperCase(),
        refOwner: refOwnerU,
        refName: refNameU,
        refStatus: "EXCLUDED",
      });
    }

    frontier = nextFrontier;
  }

  // refStatus is classified post-walk because INCLUDED depends on the FINAL
  // set of discovered objects (a back-reference may resolve to something
  // discovered in a later round than where the edge was first recorded).
  const includedNames = new Set<string>();
  for (const t of rootSet) includedNames.add(t);
  for (const o of discovered.values()) includedNames.add(o.name);

  for (const d of dependencies) {
    if (d.refOwner !== schemaUpper) d.refStatus = "OUTSIDE_SCHEMA";
    else if (includedNames.has(d.refName)) d.refStatus = "INCLUDED";
    else d.refStatus = "EXCLUDED";
  }

  const objects = [...discovered.values()].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.name.localeCompare(b.name);
  });

  return { objects, dependencies };
}
