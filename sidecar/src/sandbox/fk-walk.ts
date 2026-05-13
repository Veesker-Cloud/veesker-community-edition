import oracledb from "oracledb";
import { quoteIdent } from "./oracle-source";

export interface FkEdge {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

/**
 * Build the single-hop FK introspection SQL. Returns ALL FK relationships
 * where either side is in `:table_names` for the given `:owner`. Supports
 * compound keys via LISTAGG of the column lists.
 *
 * The result rows have shape:
 *   FROM_TABLE, FROM_COLUMNS, TO_TABLE, TO_COLUMNS
 * where FROM/TO_COLUMNS are comma-separated.
 */
export function buildFkSingleHopSql(): string {
  return `
    SELECT
      ac.table_name AS from_table,
      LISTAGG(acc_from.column_name, ',') WITHIN GROUP (ORDER BY acc_from.position) AS from_columns,
      ac_to.table_name AS to_table,
      LISTAGG(acc_to.column_name, ',') WITHIN GROUP (ORDER BY acc_to.position) AS to_columns
    FROM ALL_CONSTRAINTS ac
    JOIN ALL_CONS_COLUMNS acc_from
      ON ac.owner = acc_from.owner
      AND ac.constraint_name = acc_from.constraint_name
    JOIN ALL_CONSTRAINTS ac_to
      ON ac.r_owner = ac_to.owner
      AND ac.r_constraint_name = ac_to.constraint_name
    JOIN ALL_CONS_COLUMNS acc_to
      ON ac_to.owner = acc_to.owner
      AND ac_to.constraint_name = acc_to.constraint_name
      AND acc_to.position = acc_from.position
    WHERE ac.constraint_type = 'R'
      AND ac.owner = :owner
      AND (
        ac.table_name IN (SELECT column_value FROM TABLE(:table_names))
        OR ac_to.table_name IN (SELECT column_value FROM TABLE(:table_names))
      )
    GROUP BY ac.table_name, ac_to.table_name, ac.constraint_name
  `;
}

/**
 * Parse rows returned by the FK introspection query into FkEdge objects.
 */
export function parseFkRows(
  rows: ReadonlyArray<{
    FROM_TABLE: string;
    FROM_COLUMNS: string;
    TO_TABLE: string;
    TO_COLUMNS: string;
  }>,
): FkEdge[] {
  return rows.map((r) => ({
    fromTable: r.FROM_TABLE,
    fromColumns: r.FROM_COLUMNS.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    toTable: r.TO_TABLE,
    toColumns: r.TO_COLUMNS.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  }));
}

/** Single-hop run helper: takes a connection + table list, returns FK edges. */
export async function fkSingleHop(
  conn: oracledb.Connection,
  owner: string,
  tableNames: string[],
): Promise<FkEdge[]> {
  quoteIdent(owner);  // fail-fast on malformed owner; bind protects from injection but Oracle returns 0 rows on bad input
  // node-oracledb's TABLE() bind requires a DBMS_TYPES collection type
  // which adds setup overhead. We rewrite the SQL skeleton's
  // TABLE(:table_names) clauses into a plain IN-list of named binds
  // (`:t0, :t1, ...`). Plan 7 may optimize if call volume warrants it.
  if (tableNames.length === 0) return [];
  const inList = tableNames
    .map((t, i) => `:t${i}`)
    .join(", ");
  const binds: Record<string, string> = {};
  for (let i = 0; i < tableNames.length; i++) {
    binds[`t${i}`] = tableNames[i] ?? "";
  }
  // Replace the :table_names TABLE() bind site with a plain IN-list.
  const sql = buildFkSingleHopSql()
    .replace(
      "ac.table_name IN (SELECT column_value FROM TABLE(:table_names))",
      `ac.table_name IN (${inList})`,
    )
    .replace(
      "ac_to.table_name IN (SELECT column_value FROM TABLE(:table_names))",
      `ac_to.table_name IN (${inList})`,
    );
  if (sql.includes("TABLE(:table_names)")) {
    throw new Error(
      "fkSingleHop: SQL rewrite failed — buildFkSingleHopSql template no longer matches expected replace targets",
    );
  }
  const result = await conn.execute<{
    FROM_TABLE: string;
    FROM_COLUMNS: string;
    TO_TABLE: string;
    TO_COLUMNS: string;
  }>(sql, { owner, ...binds }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return parseFkRows(result.rows ?? []);
}

export interface FkBfsResult {
  tablesIncluded: string[];
  tableDepths: Record<string, number>;
  edges: FkEdge[];
}

export type FkSingleHopFn = (owner: string, tables: string[]) => Promise<FkEdge[]>;

/**
 * Breadth-first walk of the FK graph starting from `primaryTables`,
 * expanding outward up to `maxDepth` hops. The walk follows references
 * in BOTH directions (a FK from ORDERS to CUSTOMERS adds CUSTOMERS to
 * the include set; a FK from ORDER_ITEMS to ORDERS, when ORDERS is the
 * seed, adds ORDER_ITEMS).
 *
 * Returns deduplicated tables + each table's discovery depth + all
 * edges encountered.
 */
export async function walkFkBfs(
  owner: string,
  primaryTables: string[],
  singleHop: FkSingleHopFn,
  maxDepth: number,
): Promise<FkBfsResult> {
  const visited = new Set<string>(primaryTables);
  const tableDepths: Record<string, number> = {};
  for (const t of primaryTables) tableDepths[t] = 0;
  const allEdges: FkEdge[] = [];
  let frontier = primaryTables.slice();

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;
    const edges = await singleHop(owner, frontier);
    const nextFrontier: string[] = [];
    for (const e of edges) {
      allEdges.push(e);
      for (const t of [e.fromTable, e.toTable]) {
        if (!visited.has(t)) {
          visited.add(t);
          tableDepths[t] = depth;
          nextFrontier.push(t);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Edges may appear twice (once when from-side is the frontier, once when
  // to-side is). Dedup before returning so downstream consumers see a
  // canonical edge set.
  const edgeKey = (e: FkEdge): string =>
    `${e.fromTable}|${e.fromColumns.join(",")}|${e.toTable}|${e.toColumns.join(",")}`;
  const seenEdges = new Set<string>();
  const dedupedEdges: FkEdge[] = [];
  for (const e of allEdges) {
    const k = edgeKey(e);
    if (seenEdges.has(k)) continue;
    seenEdges.add(k);
    dedupedEdges.push(e);
  }

  return {
    tablesIncluded: Array.from(visited),
    tableDepths,
    edges: dedupedEdges,
  };
}

export interface LookupStats {
  /** Retained for caller correlation; not read by isLookupTable itself. */
  table: string;
  rowCount: number;
  incomingFkCount: number;
}

const LOOKUP_MAX_ROWS = 1_000;
const LOOKUP_MIN_INCOMING_FK = 2;

/**
 * Heuristic: a "lookup table" is small (<= 1000 rows) AND FK'd-to from
 * 2+ places. These are typical reference tables (status codes, types,
 * categories) that the BFS may not reach but the user almost always
 * needs. Caller should pass `isLookupTable(stats)` results into the
 * inclusion set as a final pass.
 */
export function isLookupTable(stats: LookupStats): boolean {
  return stats.rowCount <= LOOKUP_MAX_ROWS && stats.incomingFkCount >= LOOKUP_MIN_INCOMING_FK;
}
