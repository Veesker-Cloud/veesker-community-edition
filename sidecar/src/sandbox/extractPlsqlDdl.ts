import type { DiscoveredObject, ObjectKind } from "./discoverPlsql";

export interface DdlExtractInput {
  kind: ObjectKind;
  owner: string;
  name: string;
}

export type DdlExtractFn = (i: DdlExtractInput) => Promise<{
  ddl: string;
  spec?: string;
  body?: string;
}>;

export interface SkippedObject {
  kind: string;
  owner: string;
  name: string;
  reason: "INVALID" | "NO_PRIVILEGE" | "EXTRACTION_ERROR";
  detail?: string;
}

export interface ObjectRow {
  kind: ObjectKind;
  owner: string;
  name: string;
  status: "VALID" | "INVALID";
  ddl_size_bytes: number;
  extracted_at: string;
}

export interface SourceRow {
  kind: ObjectKind;
  owner: string;
  name: string;
  ddl: string;
  spec: string | null;
  body: string | null;
}

export interface ExtractPlsqlDdlResult {
  objectRows: ObjectRow[];
  sourceRows: SourceRow[];
  skipped: SkippedObject[];
}

function classifyError(message: string): SkippedObject["reason"] {
  // ORA-01031: explicit privilege denial.
  // ORA-00942: object visibility gap — caller has no SELECT on a referenced
  //            object. Manifests as "table or view does not exist" but is a
  //            privilege issue at heart. We classify it as NO_PRIVILEGE so the
  //            UI surfaces "ask your DBA for privileges" rather than the more
  //            confusing "object missing" framing.
  if (/ORA-01031|ORA-00942|insufficient priv/i.test(message)) return "NO_PRIVILEGE";
  return "EXTRACTION_ERROR";
}

export async function extractPlsqlDdl(
  extractor: DdlExtractFn,
  objects: DiscoveredObject[],
  onProgress: (e: { done: number; total: number }) => void,
): Promise<ExtractPlsqlDdlResult> {
  const objectRows: ObjectRow[] = [];
  const sourceRows: SourceRow[] = [];
  const skipped: SkippedObject[] = [];
  const total = objects.length;
  let done = 0;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  for (const obj of objects) {
    try {
      const ddl = await extractor({ kind: obj.kind, owner: obj.owner, name: obj.name });
      const isPackage = obj.kind === "PACKAGE";
      const ddlText = isPackage ? "" : ddl.ddl;
      const sizeBytes =
        (isPackage ? (ddl.spec?.length ?? 0) + (ddl.body?.length ?? 0) : ddl.ddl.length);

      objectRows.push({
        kind: obj.kind,
        owner: obj.owner,
        name: obj.name,
        status: "VALID",
        ddl_size_bytes: sizeBytes,
        extracted_at: now,
      });
      sourceRows.push({
        kind: obj.kind,
        owner: obj.owner,
        name: obj.name,
        ddl: ddlText,
        spec: isPackage ? (ddl.spec ?? null) : null,
        body: isPackage ? (ddl.body ?? null) : null,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      skipped.push({
        kind: obj.kind,
        owner: obj.owner,
        name: obj.name,
        reason: classifyError(detail),
        detail,
      });
    }
    done++;
    onProgress({ done, total });
  }

  return { objectRows, sourceRows, skipped };
}
