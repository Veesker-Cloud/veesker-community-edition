import oracledb from "oracledb";

/**
 * Reject any identifier we wouldn't want interpolated into SQL — same
 * allowlist as the engine's VSK_TABLE_NAME_RE (letters/digits/underscore/$,
 * starts with letter or _, max 128 chars).
 *
 * Note: sidecar/src/oracle.ts has its own quoteIdent that additionally
 * permits '#' and leading digits (needed for SYS/internal object names in
 * the interactive IDE session). This sandbox copy is intentionally stricter
 * — the build pipeline only touches user-schema tables where neither
 * character appears.
 */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;

/**
 * Quote a safe Oracle identifier with double-quotes. Throws on any
 * identifier that fails the allowlist — defense-in-depth against
 * call-site injection.
 */
export function quoteIdent(name: string): string {
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(
      `invalid identifier ${JSON.stringify(name).slice(0, 80)} (must match ${SAFE_IDENT_RE.source})`,
    );
  }
  return `"${name}"`;
}

/**
 * Full Oracle connection credentials for a one-shot sandbox build pipeline
 * connection. The pipeline does not route through CL's interactive session
 * singleton — credentials are supplied directly per build.
 */
export interface OracleConnectionConfig {
  user: string;
  password: string;
  connectString: string;
  /** Reserved for future Thick-mode tuning (e.g. oracledb.SYSDBA). */
  privilege?: number;
}

/**
 * Open a one-shot Oracle connection for the build pipeline. Caller MUST
 * `await connection.close()` when done — there is no pool here.
 *
 * Implementation note: we deliberately do NOT reuse `buildConnection` from
 * `../oracle.ts`. That function is coupled to the CL session singleton
 * (`openSession` / `withActiveSession` / `closeSession`) and its lifecycle is
 * owned by the user's interactive IDE session. The sandbox build pipeline
 * requires independent one-shot connections that open and close on their own
 * schedule without touching the user's active session state.
 */
export async function openOracleConnection(
  config: OracleConnectionConfig,
): Promise<oracledb.Connection> {
  const params: oracledb.ConnectionAttributes = {
    user: config.user,
    password: config.password,
    connectString: config.connectString,
  };
  if (config.privilege !== undefined) params.privilege = config.privilege;
  return oracledb.getConnection(params);
}

export interface ColumnMeta {
  name: string;
  /** Oracle data type as reported by ALL_TAB_COLUMNS (e.g. "VARCHAR2", "NUMBER", "DATE"). */
  dataType: string;
  /** For NUMBER, length-aware types: precision/scale/dataLength. */
  dataLength: number;
  dataPrecision: number | null;
  dataScale: number | null;
  nullable: boolean;
  columnId: number;
}

/**
 * SQL to introspect a single Oracle table's column-level schema.
 * Uses bind variables (`:owner`, `:table_name`) — caller passes
 * uppercase names to oracledb's bind layer.
 */
export function buildIntrospectionSql(): string {
  return `
    SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, column_id
    FROM ALL_TAB_COLUMNS
    WHERE owner = :owner AND table_name = :table_name
    ORDER BY column_id
  `;
}

export interface ExtractSqlInput {
  owner: string;
  table: string;
  whereClause?: string;
  rowCap?: number;
}

/**
 * Build a `SELECT *` extraction SQL for a table. Owner and table are
 * passed through {@link quoteIdent} (allowlist enforced).
 *
 * The caller-supplied `whereClause` is interpolated raw — it is NOT
 * sanitized here. The string originates from `SandboxBuildSpec` which
 * the desktop UI author/owner provides per build. Treat this surface
 * as "owner-trusted, not user-untrusted": only the desktop user who
 * authors a sandbox spec can supply it. Do NOT plumb arbitrary
 * end-user input into this argument from any other call site.
 */
export function buildExtractSql(input: ExtractSqlInput): string {
  const ownerQuoted = quoteIdent(input.owner);
  const tableQuoted = quoteIdent(input.table);
  let sql = `SELECT * FROM ${ownerQuoted}.${tableQuoted}`;
  if (input.whereClause && input.whereClause.trim().length > 0) {
    sql += ` WHERE ${input.whereClause}`;
  }
  if (input.rowCap !== undefined) {
    if (!Number.isInteger(input.rowCap) || input.rowCap <= 0) {
      throw new Error(`invalid rowCap: must be a positive integer (got ${input.rowCap})`);
    }
    sql += ` FETCH FIRST ${input.rowCap} ROWS ONLY`;
  }
  return sql;
}

/**
 * Run the introspection SQL and parse rows into typed metadata.
 * Helper used by the build pipeline; integration-tested in Task 14.
 */
export async function introspectTable(
  conn: oracledb.Connection,
  owner: string,
  tableName: string,
): Promise<ColumnMeta[]> {
  // Validate identifiers fail-fast — bind vars protect against SQL
  // injection but Oracle would silently return zero rows on a malformed
  // owner/tableName, hiding the bug. quoteIdent throws on bad input.
  quoteIdent(owner);
  quoteIdent(tableName);
  const result = await conn.execute<{
    COLUMN_NAME: string;
    DATA_TYPE: string;
    DATA_LENGTH: number;
    DATA_PRECISION: number | null;
    DATA_SCALE: number | null;
    NULLABLE: string;
    COLUMN_ID: number;
  }>(buildIntrospectionSql(), { owner, table_name: tableName }, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
  const rows = result.rows ?? [];
  return rows.map((r) => ({
    name: r.COLUMN_NAME,
    dataType: r.DATA_TYPE,
    dataLength: r.DATA_LENGTH,
    dataPrecision: r.DATA_PRECISION,
    dataScale: r.DATA_SCALE,
    nullable: r.NULLABLE === "Y",
    columnId: r.COLUMN_ID,
  }));
}

/**
 * Run a SELECT against an Oracle source and return rows as objects.
 * Stream-based variant deferred to v2 — for typical sandbox volumes
 * (~10M rows post-filter) the buffer fits comfortably.
 */
export async function extractRows(
  conn: oracledb.Connection,
  owner: string,
  tableName: string,
  whereClause: string | undefined,
  rowCap: number | undefined,
): Promise<Record<string, unknown>[]> {
  const sql = buildExtractSql({ owner, table: tableName, whereClause, rowCap });
  const result = await conn.execute<Record<string, unknown>>(sql, {}, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    fetchArraySize: 1000,
  });
  return result.rows ?? [];
}

/**
 * Walk `all_dependencies` for one BFS hop. Returns dependents (objects whose
 * type is in the PL/SQL kind set) of the given `referenced_name` set. Used by
 * the buildSandbox PL/SQL discovery phase.
 */
export async function discoverDependenciesOnce(
  conn: oracledb.Connection,
  schema: string,
  referencedNames: string[],
): Promise<{
  name: string;
  type: string;
  referencedName: string;
  referencedOwner: string;
  referencedType: string;
}[]> {
  if (referencedNames.length === 0) return [];

  // Bind names as :n0, :n1, ... — we already canonicalized to uppercase upstream.
  const placeholders = referencedNames.map((_, i) => `:n${i}`).join(", ");
  const binds: Record<string, string> = { schema };
  referencedNames.forEach((n, i) => { binds[`n${i}`] = n; });

  const res = await conn.execute<[string, string, string, string, string]>(
    `SELECT DISTINCT
       d.name,
       d.type,
       d.referenced_name,
       d.referenced_owner,
       d.referenced_type
     FROM all_dependencies d
     WHERE d.referenced_owner = :schema
       AND d.referenced_name IN (${placeholders})
       AND d.type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER', 'TYPE', 'VIEW')`,
    binds,
    { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 5000 },
  );

  return (res.rows ?? []).map((r) => ({
    name: r[0],
    type: r[1],
    referencedName: r[2],
    referencedOwner: r[3],
    referencedType: r[4],
  }));
}

/** Sample first N values of a single column for PII scanning. */
export async function sampleColumnValues(
  conn: oracledb.Connection,
  owner: string,
  tableName: string,
  columnName: string,
  sampleSize: number,
): Promise<(string | null)[]> {
  const ownerQuoted = quoteIdent(owner);
  const tableQuoted = quoteIdent(tableName);
  const colQuoted = quoteIdent(columnName);
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new Error(`invalid sampleSize: must be a positive integer (got ${sampleSize})`);
  }
  const sql = `SELECT ${colQuoted} AS v FROM ${ownerQuoted}.${tableQuoted} FETCH FIRST ${sampleSize} ROWS ONLY`;
  const result = await conn.execute<{ V: unknown }>(sql, {}, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });
  const rows = result.rows ?? [];
  return rows.map((r) => {
    if (r.V === null || r.V === undefined) return null;
    return String(r.V);
  });
}

/**
 * Extract DDL for a single PL/SQL object using a build-owned Oracle connection.
 *
 * This is the connection-accepting twin of `oracle.ts`'s `objectDdl()` — that
 * one binds to the IDE's interactive session, but the sandbox build pipeline
 * opens its own dedicated connection (via `openOracleConnection`) and must
 * route DDL extraction through that one. Otherwise headless / CI builds (no
 * IDE session) fail at extract time, and a session-context switch mid-build
 * silently reads from the wrong schema.
 */
export async function extractObjectDdl(
  conn: oracledb.Connection,
  p: { owner: string; objectType: string; objectName: string },
): Promise<{ ddl: string; spec?: string; body?: string }> {
  const fetchOpts = {
    outFormat: oracledb.OUT_FORMAT_ARRAY,
    fetchTypeHandler: (meta: { dbType: number }) =>
      meta.dbType === oracledb.DB_TYPE_CLOB ? { type: oracledb.STRING } : undefined,
  };

  const specRes = await conn.execute<[string]>(
    `SELECT DBMS_METADATA.GET_DDL(UPPER(:type), UPPER(:name), UPPER(:owner)) FROM dual`,
    { type: p.objectType, name: p.objectName, owner: p.owner },
    fetchOpts,
  );
  const rawDdl: string = ((specRes.rows?.[0]?.[0] as string) ?? "").trim();

  if (p.objectType.toUpperCase() === "PACKAGE") {
    // Oracle's GET_DDL('PACKAGE', ...) sometimes returns the combined spec+body.
    // Truncate at the PACKAGE BODY declaration to isolate just the spec.
    const bodyHeaderIdx = rawDdl.search(/\n\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+)?PACKAGE\s+BODY\b/i);
    const specDdl = bodyHeaderIdx !== -1 ? rawDdl.slice(0, bodyHeaderIdx).trim() : rawDdl;

    let bodyDdl = "";
    try {
      const bodyRes = await conn.execute<[string]>(
        `SELECT DBMS_METADATA.GET_DDL('PACKAGE_BODY', UPPER(:name), UPPER(:owner)) FROM dual`,
        { name: p.objectName, owner: p.owner },
        fetchOpts,
      );
      bodyDdl = ((bodyRes.rows?.[0]?.[0] as string) ?? "").trim();
    } catch {
      // Body absent (spec-only package) — skip silently.
    }
    const combined = bodyDdl ? specDdl + "\n\n" + bodyDdl : specDdl;
    return { ddl: combined, spec: specDdl, body: bodyDdl || undefined };
  }

  return { ddl: rawDdl };
}
