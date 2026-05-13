import oracledb from "oracledb";
import type { SchemaTableInfo } from "./types";
import { quoteIdent } from "./oracle-source";

export function buildListSchemaTablesSql(): string {
  return `
    SELECT
      t.table_name AS table_name,
      t.num_rows AS num_rows,
      (SELECT s.bytes
         FROM user_segments s
         WHERE s.segment_name = t.table_name
           AND s.segment_type = 'TABLE'
         FETCH FIRST 1 ROWS ONLY) AS size_bytes
    FROM ALL_TABLES t
    WHERE t.owner = :owner
    ORDER BY table_name
  `;
}

export async function listSchemaTables(
  conn: oracledb.Connection,
  owner: string,
): Promise<SchemaTableInfo[]> {
  // Defense-in-depth: validate the identifier shape even though :owner is
  // bound. Fails fast on hostile input before the DB round-trip. Discarded
  // return is intentional — same pattern as fkSingleHop / introspectTable.
  quoteIdent(owner);
  const result = await conn.execute<{
    TABLE_NAME: string;
    NUM_ROWS: number | null;
    SIZE_BYTES: number | null;
  }>(
    buildListSchemaTablesSql(),
    { owner },
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  return (result.rows ?? []).map((r) => ({
    name: r.TABLE_NAME,
    rowCount: r.NUM_ROWS,
    sizeBytesEst: r.SIZE_BYTES,
  }));
}
