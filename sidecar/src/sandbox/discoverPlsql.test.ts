import { describe, expect, it } from "bun:test";
import { discoverPlsql, type DependencyEdge, type DepWalkFn } from "./discoverPlsql";

function fakeWalker(graph: Record<string, DependencyEdge[]>): DepWalkFn {
  return async (_owner, names) => {
    const out: DependencyEdge[] = [];
    for (const n of names) {
      const edges = graph[n.toUpperCase()];
      if (edges) out.push(...edges);
    }
    return out;
  };
}

describe("discoverPlsql", () => {
  it("walks one hop from a table to a procedure", async () => {
    const walker = fakeWalker({
      "EMP": [
        { name: "GET_EMP", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
      ],
    });
    const r = await discoverPlsql(walker, "HR", ["EMP"]);
    expect(r.objects.map((o) => o.name)).toContain("GET_EMP");
    expect(r.objects.find((o) => o.name === "GET_EMP")?.kind).toBe("PROCEDURE");
  });

  it("walks recursively until fixed point", async () => {
    const walker = fakeWalker({
      "EMP":     [{ name: "GET_EMP",   type: "PROCEDURE", referencedName: "EMP",     referencedOwner: "HR", referencedType: "TABLE" }],
      "GET_EMP": [{ name: "CALC_BONUS", type: "FUNCTION",  referencedName: "GET_EMP", referencedOwner: "HR", referencedType: "PROCEDURE" }],
    });
    const r = await discoverPlsql(walker, "HR", ["EMP"]);
    const names = r.objects.map((o) => o.name);
    expect(names).toContain("GET_EMP");
    expect(names).toContain("CALC_BONUS");
  });

  it("respects max depth 5", async () => {
    // Build a chain longer than 5 hops: T -> P1 -> P2 -> P3 -> P4 -> P5 -> P6
    const graph: Record<string, DependencyEdge[]> = {
      "T":  [{ name: "P1", type: "PROCEDURE", referencedName: "T",  referencedOwner: "HR", referencedType: "TABLE" }],
      "P1": [{ name: "P2", type: "PROCEDURE", referencedName: "P1", referencedOwner: "HR", referencedType: "PROCEDURE" }],
      "P2": [{ name: "P3", type: "PROCEDURE", referencedName: "P2", referencedOwner: "HR", referencedType: "PROCEDURE" }],
      "P3": [{ name: "P4", type: "PROCEDURE", referencedName: "P3", referencedOwner: "HR", referencedType: "PROCEDURE" }],
      "P4": [{ name: "P5", type: "PROCEDURE", referencedName: "P4", referencedOwner: "HR", referencedType: "PROCEDURE" }],
      "P5": [{ name: "P6", type: "PROCEDURE", referencedName: "P5", referencedOwner: "HR", referencedType: "PROCEDURE" }],
    };
    const r = await discoverPlsql(fakeWalker(graph), "HR", ["T"]);
    const names = r.objects.map((o) => o.name);
    expect(names).toContain("P5");
    expect(names).not.toContain("P6"); // depth 6 — past max
  });

  it("topologically sorts: TYPE → PACKAGE → PROCEDURE/FUNCTION/TRIGGER → VIEW", async () => {
    const walker = fakeWalker({
      "EMP": [
        { name: "GET_EMP",       type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        { name: "EMP_VIEW",      type: "VIEW",      referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        { name: "EMP_PKG",       type: "PACKAGE",   referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        { name: "EMP_TRG",       type: "TRIGGER",   referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        { name: "EMP_TYPE",      type: "TYPE",      referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
      ],
    });
    const r = await discoverPlsql(walker, "HR", ["EMP"]);
    const order = r.objects.map((o) => o.kind);
    expect(order.indexOf("TYPE")).toBeLessThan(order.indexOf("PACKAGE"));
    expect(order.indexOf("PACKAGE")).toBeLessThan(order.indexOf("PROCEDURE"));
    expect(order.indexOf("PROCEDURE")).toBeLessThan(order.indexOf("VIEW"));
  });

  it("classifies referenced objects: INCLUDED / EXCLUDED / OUTSIDE_SCHEMA", async () => {
    const walker = fakeWalker({
      "EMP": [
        { name: "EMP_VIEW", type: "VIEW", referencedName: "EMP",  referencedOwner: "HR",      referencedType: "TABLE" },
        { name: "EMP_VIEW", type: "VIEW", referencedName: "DEPT", referencedOwner: "HR",      referencedType: "TABLE" },   // EXCLUDED — not in tableSet
        { name: "EMP_VIEW", type: "VIEW", referencedName: "AUD",  referencedOwner: "AUDIT",   referencedType: "TABLE" },   // OUTSIDE_SCHEMA
      ],
    });
    const r = await discoverPlsql(walker, "HR", ["EMP"]);
    const deps = r.dependencies.filter((d) => d.name === "EMP_VIEW");
    const refStatusByName = new Map(deps.map((d) => [d.refName, d.refStatus]));
    expect(refStatusByName.get("EMP")).toBe("INCLUDED");
    expect(refStatusByName.get("DEPT")).toBe("EXCLUDED");
    expect(refStatusByName.get("AUD")).toBe("OUTSIDE_SCHEMA");
  });

  it("treats PACKAGE BODY as part of the same PACKAGE", async () => {
    const walker = fakeWalker({
      "EMP":     [{ name: "EMP_PKG", type: "PACKAGE",      referencedName: "EMP",     referencedOwner: "HR", referencedType: "TABLE" }],
      "EMP_PKG": [{ name: "EMP_PKG", type: "PACKAGE BODY", referencedName: "EMP_PKG", referencedOwner: "HR", referencedType: "PACKAGE" }],
    });
    const r = await discoverPlsql(walker, "HR", ["EMP"]);
    const pkgs = r.objects.filter((o) => o.name === "EMP_PKG");
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.kind).toBe("PACKAGE");
  });

  it("dedupes dependency edges seen across multiple BFS rounds", async () => {
    // Two distinct dependents (P1, P2) both reach EMP via different paths,
    // and BOTH walker rounds also re-emit the original P1->EMP edge. Without
    // the seenEdges guard, the dependencies array would carry the P1->EMP
    // edge twice.
    let call = 0;
    const walker: DepWalkFn = async () => {
      call++;
      if (call === 1) {
        return [
          { name: "P1", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        ];
      }
      // Second round: emit the SAME P1->EMP edge again plus a new P2->EMP edge.
      return [
        { name: "P1", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        { name: "P2", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
      ];
    };
    const r = await discoverPlsql(walker, "HR", ["EMP"]);
    const p1Edges = r.dependencies.filter((d) => d.name === "P1" && d.refName === "EMP");
    expect(p1Edges).toHaveLength(1);
  });
});
