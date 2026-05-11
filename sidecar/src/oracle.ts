// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import oracledb from "oracledb";
import os from "node:os";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { embedText, type EmbedParams } from "./embedding";
import { log } from "./logger";
import { SESSION_UUID } from "./state";
import { emitNotification } from "./notifications";

// L3.4 — Sprint C Onda 3: cursor-batched fetch granularity for streaming
// progress notifications. 200 rows/batch keeps round-trip overhead low while
// providing fine enough progress resolution for the renderer (50ms throttle).
export const QUERY_STREAM_BATCH = 200;
// Throttle floor between progress notifications: don't emit more than once
// every 50ms even if many batches arrive faster. Combined with the row-count
// trigger this caps ~20 notifications/sec/query in the worst case.
export const QUERY_PROGRESS_THROTTLE_MS = 50;

// Guarantee DML never auto-commits regardless of driver version or future defaults.
oracledb.autoCommit = false;

// ── Application identification (DBMS_APPLICATION_INFO + DBMS_SESSION) ────────
// Resolved once at startup. Surfaced to Oracle on every fresh connection so
// V$SESSION rows show "Veesker IDE x.y.z" / user@host / vsk-<uuid> instead of
// NULL — recognized-IDE posture for compliance / forensic auditors.
const APP_NAME = "Veesker IDE";
const ORACLE_MODULE_MAX = 48;
const ORACLE_CLIENT_INFO_MAX = 64;
const ORACLE_CLIENT_ID_MAX = 64;
const ORACLE_ACTION_MAX = 32;
const DEFAULT_ACTION = "SQL Editor";

let _appVersion: string | null = null;
function getAppVersion(): string {
  if (_appVersion !== null) return _appVersion;
  const candidates = [
    join(import.meta.dir, "..", "..", "package.json"),
    join(import.meta.dir, "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const pkg = JSON.parse(raw) as { version?: string; name?: string };
      if (pkg.name === "veesker" && typeof pkg.version === "string") {
        _appVersion = pkg.version;
        return _appVersion;
      }
    } catch {
      /* try next */
    }
  }
  _appVersion = "unknown";
  return _appVersion;
}

export function buildModuleString(version: string): string {
  return `${APP_NAME} ${version}`.slice(0, ORACLE_MODULE_MAX);
}

export function buildClientInfoString(username: string, hostname: string): string {
  return `${username}@${hostname}`.slice(0, ORACLE_CLIENT_INFO_MAX);
}

export function buildClientIdentifierString(uuid: string): string {
  return `vsk-${uuid}`.slice(0, ORACLE_CLIENT_ID_MAX);
}

/**
 * Returns the parsed SERVICE_NAME from a TNS descriptor or easy-connect string.
 * Supports: "host:port/service", "//host:port/service",
 * "(DESCRIPTION=...(SERVICE_NAME=svc)...)".
 * If no pattern matches, returns the input trimmed (no truncation).
 */
export function extractServiceName(connectString: string): string {
  if (!connectString) return "";
  const tns = connectString.match(/SERVICE_NAME\s*=\s*([^)\s]+)/i);
  if (tns) return tns[1];
  const easy = connectString.match(/\/\/?[^/]+\/([^?\s/]+)/);
  if (easy) return easy[1];
  const slash = connectString.match(/\/([^?\s/]+)$/);
  if (slash) return slash[1];
  return connectString.trim();
}

const SET_APP_INFO_SQL =
  `BEGIN
     DBMS_APPLICATION_INFO.SET_MODULE(:module, :action);
     DBMS_APPLICATION_INFO.SET_CLIENT_INFO(:clientInfo);
     DBMS_SESSION.SET_IDENTIFIER(:clientId);
   END;`;

/**
 * Best-effort: brand the connection in V$SESSION so audits recognize the IDE.
 * If the user lacks privilege on DBMS_SESSION.SET_IDENTIFIER (e.g. some 9i/10g
 * roles) the PL/SQL block raises and we just log + continue — connection
 * usability must not depend on this.
 */
async function applySessionIdentification(conn: oracledb.Connection): Promise<void> {
  const username = (() => {
    try { return os.userInfo().username; } catch { return "unknown"; }
  })();
  const hostname = (() => {
    try { return os.hostname(); } catch { return "unknown"; }
  })();
  const binds = {
    module: buildModuleString(getAppVersion()),
    action: DEFAULT_ACTION,
    clientInfo: buildClientInfoString(username, hostname),
    clientId: buildClientIdentifierString(SESSION_UUID),
  };
  try {
    await conn.execute(SET_APP_INFO_SQL, binds);
  } catch (err) {
    log.warn(
      `[oracle.identification] DBMS_APPLICATION_INFO/SET_IDENTIFIER failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Update only the ACTION on the active session — module + client_info stay. */
export async function setSessionAction(action: string): Promise<void> {
  const trimmed = String(action ?? DEFAULT_ACTION).slice(0, ORACLE_ACTION_MAX);
  const conn = getActiveSession();
  try {
    await conn.execute(
      `BEGIN DBMS_APPLICATION_INFO.SET_MODULE(:module, :action); END;`,
      {
        module: buildModuleString(getAppVersion()),
        action: trimmed,
      }
    );
  } catch (err) {
    log.warn(
      `[oracle.identification] SET_MODULE failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Validate and quote an Oracle identifier for use in double-quoted SQL interpolation. */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_$#]{1,128}$/.test(name)) {
    throw new Error(`Invalid Oracle identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

let _driverMode: "thin" | "thick" = "thin";

function dirHasOracleClientLib(dir: string): boolean {
  try {
    const files = readdirSync(dir);
    if (process.platform === "win32") return files.includes("oci.dll");
    if (process.platform === "darwin")
      return files.some((f) => f === "libclntsh.dylib" || f.startsWith("libclntsh.dylib."));
    return files.some((f) => f === "libclntsh.so" || f.startsWith("libclntsh.so."));
  } catch {
    return false;
  }
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Scan well-known filesystem locations for an existing Oracle client install.
 * Most Oracle developer machines already have one (PL/SQL Developer, SQL Developer,
 * sqlplus, full DB client) — we look for it instead of forcing the user to download
 * Instant Client separately or set an env var.
 */
function findInstantClientCandidates(): string[] {
  const found: string[] = [];

  if (process.platform === "win32") {
    // C:\instantclient_*
    for (const sub of listSubdirs("C:\\")) {
      if (basename(sub).toLowerCase().startsWith("instantclient") && dirHasOracleClientLib(sub)) {
        found.push(sub);
      }
    }
    // C:\Oracle\<anything>\bin and C:\Oracle\<anything>\<anything>\bin (covers Middleware/Oracle_Home)
    for (const oraSub of listSubdirs("C:\\Oracle")) {
      const bin = join(oraSub, "bin");
      if (dirHasOracleClientLib(bin)) found.push(bin);
      for (const oraSub2 of listSubdirs(oraSub)) {
        const bin2 = join(oraSub2, "bin");
        if (dirHasOracleClientLib(bin2)) found.push(bin2);
      }
    }
    // C:\app\<user>\product\<version>\(client|dbhome)_<n>\bin (Oracle Universal Installer default)
    for (const userDir of listSubdirs("C:\\app")) {
      const productDir = join(userDir, "product");
      for (const verDir of listSubdirs(productDir)) {
        for (const installRoot of listSubdirs(verDir)) {
          const name = basename(installRoot).toLowerCase();
          if (name.startsWith("client_") || name.startsWith("dbhome_")) {
            const bin = join(installRoot, "bin");
            if (dirHasOracleClientLib(bin)) found.push(bin);
          }
        }
      }
    }
    // C:\Program Files\Oracle\*\bin and (x86)
    for (const root of ["C:\\Program Files\\Oracle", "C:\\Program Files (x86)\\Oracle"]) {
      for (const oraSub of listSubdirs(root)) {
        const bin = join(oraSub, "bin");
        if (dirHasOracleClientLib(bin)) found.push(bin);
      }
    }
  } else if (process.platform === "darwin") {
    for (const root of ["/opt/oracle", "/usr/local/oracle"]) {
      for (const sub of listSubdirs(root)) {
        if (basename(sub).toLowerCase().startsWith("instantclient") && dirHasOracleClientLib(sub)) {
          found.push(sub);
        }
      }
    }
  } else {
    for (const root of ["/opt/oracle", "/usr/local/oracle"]) {
      for (const sub of listSubdirs(root)) {
        if (basename(sub).toLowerCase().startsWith("instantclient") && dirHasOracleClientLib(sub)) {
          found.push(sub);
        }
      }
    }
    for (const verDir of listSubdirs("/usr/lib/oracle")) {
      for (const client of listSubdirs(verDir)) {
        if (basename(client).startsWith("client")) {
          const lib = join(client, "lib");
          if (dirHasOracleClientLib(lib)) found.push(lib);
        }
      }
    }
  }

  return [...new Set(found)];
}

/**
 * Try to enable node-oracledb Thick mode (using Oracle Instant Client). Thick mode
 * supports legacy password verifiers (e.g., 0x939) that pre-12c databases sometimes
 * still hold, while Thin mode rejects them with NJS-116. Once initOracleClient succeeds
 * the entire process is locked into Thick mode and every subsequent getConnection uses it.
 *
 * Resolution order:
 *   1. VEESKER_INSTANT_CLIENT_DIR env var (explicit user override)
 *   2. Default initOracleClient — uses PATH / LD_LIBRARY_PATH / DYLD_LIBRARY_PATH
 *   3. Auto-discovered paths (typical Oracle / Instant Client install locations)
 *
 * Set VEESKER_FORCE_THIN=1 to stay in Thin mode regardless.
 */
// LOW-002 (audit 2026-04-30): cache the discovered libDir to skip the
// filesystem walk on subsequent starts. Cache lives next to the sidecar's
// log file (in VEESKER_LOG_DIR) — a writable location chosen by the Tauri
// host. If unset (e.g., dev mode), we just skip caching.
function cacheFilePath(): string | null {
  const dir = process.env.VEESKER_LOG_DIR;
  return dir ? join(dir, "instantclient-libdir.cache") : null;
}

function readCachedLibDir(): string | null {
  const path = cacheFilePath();
  if (!path) return null;
  try {
    const cached = readFileSync(path, "utf8").trim();
    if (cached && dirHasOracleClientLib(cached)) return cached;
  } catch {
    /* no cache yet */
  }
  return null;
}

function writeCachedLibDir(libDir: string): void {
  const path = cacheFilePath();
  if (!path) return;
  try {
    writeFileSync(path, libDir, { encoding: "utf8" });
  } catch {
    /* non-fatal */
  }
}

export function tryEnableThickMode(): { mode: "thin" | "thick"; libDir?: string; error?: string } {
  if (process.env.VEESKER_FORCE_THIN === "1") {
    process.stderr.write("[oracle] VEESKER_FORCE_THIN=1 — using Thin mode\n");
    _driverMode = "thin";
    return { mode: "thin" };
  }

  // The compiled Bun binary doesn't include oracledb's native .node binding (the loader
  // uses a dynamic require path Bun's bundler can't trace). The Tauri host passes the
  // directory containing the binding via VEESKER_ORACLEDB_BINARY_DIR; we forward it as
  // initOracleClient's `binaryDir` option.
  const binaryDir = process.env.VEESKER_ORACLEDB_BINARY_DIR;
  if (binaryDir) {
    process.stderr.write(`[oracle] using native binding from ${binaryDir}\n`);
  } else {
    process.stderr.write("[oracle] VEESKER_ORACLEDB_BINARY_DIR not set — Thick mode will likely fail with NJS-045\n");
  }

  const attempts: Array<{ libDir?: string; label: string }> = [];
  const explicit = process.env.VEESKER_INSTANT_CLIENT_DIR;
  if (explicit) attempts.push({ libDir: explicit, label: `env VEESKER_INSTANT_CLIENT_DIR=${explicit}` });
  // LOW-002: cached libDir from a previous successful init wins second priority.
  const cached = readCachedLibDir();
  if (cached) attempts.push({ libDir: cached, label: `cache hit ${cached}` });
  attempts.push({ label: "default search path" });
  // Only walk the filesystem if there's no cache hit. findInstantClientCandidates()
  // does a synchronous readdir recursion across C:\\app\\<user>\\product\\..., C:\\Oracle,
  // C:\\Program Files\\Oracle, etc., which is the 1-3s cost the cache exists to skip.
  // Discovered via ultrareview bug_003 — the previous version called this even on
  // cache hits, defeating the whole point of LOW-002.
  if (!cached) {
    for (const dir of findInstantClientCandidates()) {
      attempts.push({ libDir: dir, label: `auto-discovered ${dir}` });
    }
  }

  for (const a of attempts) {
    try {
      const opts: { libDir?: string; binaryDir?: string } = {};
      if (a.libDir) opts.libDir = a.libDir;
      if (binaryDir) opts.binaryDir = binaryDir;
      if (Object.keys(opts).length > 0) oracledb.initOracleClient(opts);
      else oracledb.initOracleClient();
      _driverMode = "thick";
      process.stderr.write(`[oracle] Thick mode enabled — ${a.label}\n`);
      if (a.libDir) writeCachedLibDir(a.libDir);
      return { mode: "thick", libDir: a.libDir };
    } catch (err) {
      const msg = String(err).split("\n")[0];
      process.stderr.write(`[oracle] Thick init failed (${a.label}): ${msg}\n`);
    }
  }

  process.stderr.write("[oracle] no Oracle client library found, using Thin mode\n");
  _driverMode = "thin";
  return { mode: "thin", error: "no Instant Client available" };
}

export function getDriverMode(): "thin" | "thick" {
  return _driverMode;
}

const NJS_116_HINT =
  "\n\nThis password verifier is unsupported in Thin mode. Install Oracle Instant Client " +
  "(https://www.oracle.com/database/technologies/instant-client/downloads.html) and restart " +
  "Veesker — it will auto-enable Thick mode which supports all verifier types.";

function decorateOracleError(err: unknown): Error {
  if (err instanceof Error && err.message.includes("NJS-116") && _driverMode === "thin") {
    return new Error(err.message + NJS_116_HINT);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export type ConnectionSafety = {
  env?: "dev" | "staging" | "prod";
  readOnly?: boolean;
  /** Per-statement timeout (ms). 0 / undefined = unlimited. */
  statementTimeoutMs?: number;
  warnUnsafeDml?: boolean;
  autoPerfAnalysis?: boolean;
  /**
   * L2.1 PSDPM (PL/SQL Developer Parity Mode). When true, only user-initiated
   * RPCs (origin: user_typed / user_clicked) are allowed to execute SQL on the
   * connection. AI tool runs (CL only), embed batches (CL only), and any
   * background pre-fetches are blocked. Propagated from `workspace.open`
   * params; enforced by `enforcePsdpmForOrigin`.
   */
  psdpm?: boolean;
};

export type ConnectionTestParams =
  | {
      authType: "basic";
      host: string;
      port: number;
      serviceName: string;
      username: string;
      password: string;
      // Safety fields (flattened) — present on saved-connection params, absent on test
      env?: "dev" | "staging" | "prod" | "local";
      readOnly?: boolean;
      statementTimeoutMs?: number;
      warnUnsafeDml?: boolean;
      autoPerfAnalysis?: boolean;
      psdpm?: boolean;
    }
  | {
      authType: "wallet";
      walletDir: string;
      walletPassword: string;
      connectAlias: string;
      username: string;
      password: string;
      env?: "dev" | "staging" | "prod" | "local";
      readOnly?: boolean;
      statementTimeoutMs?: number;
      warnUnsafeDml?: boolean;
      autoPerfAnalysis?: boolean;
      psdpm?: boolean;
    };

function safetyFromParams(p: ConnectionTestParams): ConnectionSafety {
  return {
    env: p.env,
    readOnly: p.readOnly === true,
    statementTimeoutMs: p.statementTimeoutMs,
    warnUnsafeDml: p.warnUnsafeDml === true,
    autoPerfAnalysis: p.autoPerfAnalysis !== false,
    psdpm: p.psdpm === true,
  };
}

export type ConnectionTestResult = {
  ok: true;
  serverVersion: string;
  elapsedMs: number;
};

export async function connectionTest(
  params: ConnectionTestParams
): Promise<ConnectionTestResult> {
  const started = Date.now();
  let conn: oracledb.Connection;
  try {
    conn =
      params.authType === "basic"
        ? await oracledb.getConnection({
            user: params.username,
            password: params.password,
            connectString: `${params.host}:${params.port}/${params.serviceName}`,
            connectTimeout: 10,
          })
        : await oracledb.getConnection({
            user: params.username,
            password: params.password,
            connectString: params.connectAlias,
            configDir: params.walletDir,
            walletLocation: params.walletDir,
            walletPassword: params.walletPassword,
            connectTimeout: 10,
          });
  } catch (err) {
    throw decorateOracleError(err);
  }
  try {
    await applySessionIdentification(conn);
    const result = await conn.execute<{ V: string }>(
      "SELECT BANNER_FULL AS V FROM V$VERSION WHERE ROWNUM = 1",
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const banner = result.rows?.[0]?.V ?? "Oracle (version unavailable)";
    return {
      ok: true,
      serverVersion: banner,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await conn.close();
  }
}

import {
  setSession,
  clearSession,
  hasSession,
  getActiveSession,
  setSessionParams,
  setSessionSafety,
  getSessionSafety,
  withSessionLock,
  getTxState,
  resetTxState,
  recordTxModifying,
  setTxId,
  type TxModifyingType,
} from "./state";
import {
  RpcCodedError,
  SESSION_LOST,
  ORACLE_ERR,
  READ_ONLY_BLOCKED,
  UNSAFE_DML_WARNING,
  UNSAFE_DML_STAGING,
  UNSAFE_DML_PROD_BLOCKED,
  TRUNCATE_PROD_BLOCKED,
  AUTOCOMMIT_VIOLATION,
  PSDPM_BLOCKED,
  SESSION_SELF_PRIV_MISSING,
  SESSION_SELF_TRANSIENT,
  SESSION_SELF_NOT_FOUND,
  MVIEW_REFRESH_PROD_REQUIRES_CONFIRMATION,
  JOB_RUN_PROD_REQUIRES_CONFIRMATION,
  JOB_DISABLE_PROD_REQUIRES_CONFIRMATION,
  INVALID_IDENTIFIER,
  SESSION_KILL_PROD_REQUIRES_CONFIRMATION,
  INVALID_SESSION_ID,
} from "./errors";
import { classifySql, isReadOnlySafe, isUnsafeBulkDml, isMergeSql, isTruncateSql, extractTableFromSql } from "./sql-kind";

/** Injectable clock — swap in tests to simulate time passing. */
interface Clock { now(): number; }
const wallClock: Clock = { now: () => Date.now() };
let _clock: Clock = wallClock;
/** Test-only — never call this in production code. */
export function _testInjectClock(c: Clock): void { _clock = c; }
export function _testResetClock(): void { _clock = wallClock; }

type UnsafeDmlWindow = { table: string; expiresAt: number };
let _unsafeDmlWindow: UnsafeDmlWindow | null = null;
const UNSAFE_DML_WINDOW_TTL_MS = 15 * 60 * 1000;

/**
 * Belt-and-suspenders runtime assertion that mirrors the global
 * `oracledb.autoCommit = false` pinned at module load. If a refactor or future
 * driver upgrade ever flips it back, every code path that goes through
 * withActiveSession (or directly through this helper) raises a coded RPC error
 * instead of silently committing user DML.
 */
export function assertAutoCommitFalse(conn: oracledb.Connection): void {
  // `autoCommit` is a writable property on oracledb.Connection — undefined ≠ false.
  // We treat anything other than literal `false` as a violation.
  const ac = (conn as unknown as { autoCommit?: unknown }).autoCommit;
  if (ac === undefined || ac === false) return;
  try {
    (conn as unknown as { autoCommit: boolean }).autoCommit = false;
  } catch {
    /* property may be non-writable in some driver versions; assertion still fires */
  }
  log.warn(
    "[veesker.safety] AUTOCOMMIT_ASSERT_FAILED: connection had autoCommit=true on checkout — forced back to false"
  );
  throw new RpcCodedError(
    AUTOCOMMIT_VIOLATION,
    "Internal safety violation: autoCommit was true on connection checkout. This should never happen."
  );
}

export type OpenSessionParams = ConnectionTestParams;
export type OpenSessionResult = {
  serverVersion: string;
  currentSchema: string;
  user: string;          // L3.5 — uppercase username for StatusBar user@service
  serviceName: string;   // L3.5 — extracted from connectString
};

export function isLostSessionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message || "";
  // node-oracledb thin / Oracle codes that mean "session is gone":
  // NJS-003 connection, NJS-500 driver/connect, ORA-03113 EOF, ORA-03114 not connected
  return (
    m.includes("NJS-003") ||
    m.includes("NJS-500") ||
    m.includes("ORA-03113") ||
    m.includes("ORA-03114") ||
    m.includes("DPI-1010")
  );
}

export async function buildConnection(p: OpenSessionParams): Promise<oracledb.Connection> {
  try {
    if (p.authType === "basic") {
      return await oracledb.getConnection({
        user: p.username,
        password: p.password,
        connectString: `${p.host}:${p.port}/${p.serviceName}`,
        connectTimeout: 15,
      });
    }
    return await oracledb.getConnection({
      user: p.username,
      password: p.password,
      connectString: p.connectAlias,
      configDir: p.walletDir,
      walletLocation: p.walletDir,
      walletPassword: p.walletPassword,
      connectTimeout: 15,
    });
  } catch (err) {
    throw decorateOracleError(err);
  }
}

export async function openSession(p: OpenSessionParams): Promise<OpenSessionResult> {
  return withSessionLock(async () => {
    // Replace any prior session before opening a new one.
    if (hasSession()) {
      try {
        await getActiveSession().close();
      } catch {
        // Best-effort close — old session may already be dead.
      }
      clearSession();
    }
    _unsafeDmlWindow = null;

    const conn = await buildConnection(p);
    try {
      // Brand the session in V$SESSION before any user query can run on it.
      // Best-effort: failures here must not abort the open.
      await applySessionIdentification(conn);

      const safety = safetyFromParams(p);
      // Apply per-statement timeout. Setting to 0 means no timeout (oracledb default).
      // We only set if > 0, so existing sessions are unaffected.
      if (typeof safety.statementTimeoutMs === "number" && safety.statementTimeoutMs > 0) {
        try {
          conn.callTimeout = safety.statementTimeoutMs;
        } catch (e) {
          // Non-fatal: log but proceed. Old oracledb versions may not have callTimeout.
          log.error(`[oracle] failed to apply callTimeout: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const versionRes = await conn.execute<{ V: string }>(
        "SELECT BANNER_FULL AS V FROM V$VERSION WHERE ROWNUM = 1",
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const schemaRes = await conn.execute<{ S: string }>(
        "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL",
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const serverVersion = versionRes.rows?.[0]?.V ?? "Oracle (version unavailable)";
      const currentSchema = schemaRes.rows?.[0]?.S ?? p.username.toUpperCase();
      const user = p.username.toUpperCase();
      const serviceName =
        p.authType === "basic"
          ? p.serviceName
          : p.connectAlias;
      setSession(conn, currentSchema);
      setSessionParams(p);
      setSessionSafety(safety);
      return { serverVersion, currentSchema, user, serviceName };
    } catch (err) {
      // Failed during the version/schema bootstrap — clean up the half-open session.
      try { await conn.close(); } catch {}
      throw err;
    }
  });
}

export async function closeSession(): Promise<{ closed: true }> {
  return withSessionLock(async () => {
    if (hasSession()) {
      try {
        await getActiveSession().close();
      } catch {
        // Best-effort.
      }
      clearSession();
    }
    return { closed: true };
  });
}

// Helper used by metadata handlers to wrap Oracle errors into coded RPC errors
// and to clear stale session state when the connection is gone.
export async function withActiveSession<T>(
  fn: (conn: oracledb.Connection) => Promise<T>
): Promise<T> {
  const conn = getActiveSession();
  assertAutoCommitFalse(conn);
  try {
    return await fn(conn);
  } catch (err) {
    // Let already-coded errors (e.g. QUERY_CANCELLED) pass through as-is.
    if (err instanceof RpcCodedError) throw err;
    if (isLostSessionError(err)) {
      clearSession();
      throw new RpcCodedError(SESSION_LOST, (err as Error).message);
    }
    throw new RpcCodedError(
      ORACLE_ERR,
      err instanceof Error ? err.message : String(err)
    );
  }
}

import { OBJECT_NOT_FOUND, QUERY_CANCELLED, SPLITTER_ERROR } from "./errors";
import { splitSql } from "./sql-splitter";

export type SchemaRow = { name: string; isCurrent: boolean };
export type ObjectRef = { name: string };
export type ObjectKind =
  | "TABLE" | "VIEW" | "SEQUENCE"
  | "MATERIALIZED_VIEW" | "SYNONYM" | "DB_LINK";

export type ColumnDef = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
  dataDefault: string | null;
  comments: string | null;
  isVector: boolean;
};
export type IndexDef = { name: string; isUnique: boolean; columns: string[] };
export type TableDetails = {
  columns: ColumnDef[];
  indexes: IndexDef[];
  rowCount: number | null;
  lastAnalyzed: string | null;
};

function formatDataType(
  dataType: string,
  length: number | null,
  precision: number | null,
  scale: number | null
): string {
  const dt = dataType.toUpperCase();
  if (dt === "NUMBER") {
    if (precision != null && scale != null && scale > 0) return `NUMBER(${precision},${scale})`;
    if (precision != null) return `NUMBER(${precision})`;
    return "NUMBER";
  }
  if (dt === "VARCHAR2" || dt === "NVARCHAR2" || dt === "CHAR" || dt === "NCHAR" || dt === "RAW") {
    return length != null ? `${dt}(${length})` : dt;
  }
  if (dt.startsWith("TIMESTAMP")) {
    return scale != null ? `TIMESTAMP(${scale})` : dt;
  }
  return dt;
}

export async function schemaList(): Promise<{ schemas: SchemaRow[] }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{ NAME: string; IS_CURRENT: number }>(
      `SELECT username AS NAME,
              CASE WHEN username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 1 ELSE 0 END AS IS_CURRENT
         FROM all_users
         ORDER BY (CASE WHEN username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 0 ELSE 1 END), username`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const schemas: SchemaRow[] = (res.rows ?? []).map((r) => ({
      name: r.NAME,
      isCurrent: r.IS_CURRENT === 1,
    }));
    return { schemas };
  });
}

export async function objectsList(p: {
  owner: string;
  type: ObjectKind;
}): Promise<{ objects: ObjectRef[] }> {
  return withActiveSession(async (conn) => {
    // MATERIALIZED_VIEW in ALL_OBJECTS uses a space, not underscore
    const typeMap: Partial<Record<ObjectKind, string>> = {
      MATERIALIZED_VIEW: "MATERIALIZED VIEW",
    };
    const oracleType = typeMap[p.type] ?? p.type;
    const res = await conn.execute<{ NAME: string }>(
      `SELECT object_name AS NAME
         FROM all_objects
        WHERE owner = :owner AND object_type = :type
        ORDER BY object_name`,
      { owner: p.owner, type: oracleType },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return { objects: (res.rows ?? []).map((r) => ({ name: r.NAME })) };
  });
}

export type MViewDetails = {
  name: string;
  owner: string;
  refreshMethod: string;
  refreshMode: string;
  lastRefreshDate: string | null;
  staleness: string;
  query: string | null;
};

export async function mviewDetails(p: {
  owner: string;
  name: string;
}): Promise<{ detail: MViewDetails | null }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{
        MVIEW_NAME: string;
        OWNER: string;
        REFRESH_METHOD: string;
        REFRESH_MODE: string;
        LAST_REFRESH_DATE: Date | null;
        STALENESS: string;
        QUERY: string | null;
      }>(
        `SELECT mview_name, owner, refresh_method, refresh_mode,
                last_refresh_date, staleness, query
           FROM all_mviews
          WHERE owner = :owner AND mview_name = :name`,
        { owner: p.owner, name: p.name },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const r = res.rows?.[0] ?? null;
      if (!r) return { detail: null };
      return {
        detail: {
          name: r.MVIEW_NAME,
          owner: r.OWNER,
          refreshMethod: r.REFRESH_METHOD,
          refreshMode: r.REFRESH_MODE,
          lastRefreshDate: r.LAST_REFRESH_DATE ? r.LAST_REFRESH_DATE.toISOString() : null,
          staleness: r.STALENESS,
          query: r.QUERY,
        },
      };
    } catch (e: any) {
      if (e.errorNum === 942) {
        // ALL_MVIEWS not accessible — fall back to USER_MVIEWS
        const res = await conn.execute<{
          MVIEW_NAME: string;
          REFRESH_METHOD: string;
          REFRESH_MODE: string;
          LAST_REFRESH_DATE: Date | null;
          STALENESS: string;
          QUERY: string | null;
        }>(
          `SELECT mview_name, refresh_method, refresh_mode,
                  last_refresh_date, staleness, query
             FROM user_mviews
            WHERE mview_name = :name`,
          { name: p.name },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const r = res.rows?.[0] ?? null;
        if (!r) return { detail: null };
        return {
          detail: {
            name: r.MVIEW_NAME,
            owner: p.owner,
            refreshMethod: r.REFRESH_METHOD,
            refreshMode: r.REFRESH_MODE,
            lastRefreshDate: r.LAST_REFRESH_DATE ? r.LAST_REFRESH_DATE.toISOString() : null,
            staleness: r.STALENESS,
            query: r.QUERY,
          },
        };
      }
      throw e;
    }
  });
}

export async function mviewRefresh(p: {
  owner: string;
  name: string;
  method: "FAST" | "COMPLETE" | "FORCE";
  confirmedProdRefresh?: boolean;
}): Promise<{ ok: true; durationMs: number; envReal: string }> {
  return withActiveSession(async (conn) => {
    const safety = getSessionSafety();
    const envReal = (safety.env as string | undefined) ?? "unknown";

    if (envReal === "prod" && !p.confirmedProdRefresh) {
      throw new RpcCodedError(
        MVIEW_REFRESH_PROD_REQUIRES_CONFIRMATION,
        `mview.refresh on prod requires confirmedProdRefresh=true. ` +
        `The UI must display the PROD confirmation dialog before calling this RPC.`
      );
    }

    const ownerDotName = `${p.owner}.${p.name}`;
    const start = Date.now();
    await conn.execute(
      `BEGIN DBMS_MVIEW.REFRESH(:mv_name, :method); END;`,
      { mv_name: ownerDotName, method: p.method }
    );
    const durationMs = Date.now() - start;
    log.info(
      `[mview] refresh owner=${p.owner} name=${p.name} method=${p.method} ` +
      `env_real=${envReal} confirmed_prod=${p.confirmedProdRefresh ?? false} durationMs=${durationMs}`
    );
    return { ok: true, durationMs, envReal };
  });
}

export type SynonymDetails = {
  name: string;
  owner: string;
  targetSchema: string;
  targetObject: string;
  targetDbLink: string | null;
  ddl: string;
};

export async function synonymDetails(p: {
  owner: string;
  name: string;
}): Promise<{ detail: SynonymDetails | null }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{
      SYNONYM_NAME: string;
      OWNER: string;
      TABLE_OWNER: string;
      TABLE_NAME: string;
      DB_LINK: string | null;
      DDL: string;
    }>(
      `SELECT syn.synonym_name,
              syn.owner,
              syn.table_owner,
              syn.table_name,
              syn.db_link,
              'CREATE '
                  || CASE WHEN syn.owner = 'PUBLIC' THEN 'PUBLIC ' ELSE '' END
                  || 'SYNONYM '
                  || CASE
                       WHEN syn.owner = 'PUBLIC'
                            THEN ''
                       WHEN syn.owner = SYS_CONTEXT('USERENV', 'CURRENT_USER')
                            THEN ''
                       ELSE syn.owner || '.'
                     END
                  || syn.synonym_name
                  || ' FOR '
                  || syn.table_owner || '.' || syn.table_name
                  || CASE WHEN syn.db_link IS NOT NULL THEN '@' || syn.db_link ELSE '' END
                  || ';' AS ddl
         FROM all_synonyms syn
        WHERE syn.synonym_name = :name
          AND syn.owner = :owner`,
      { name: p.name, owner: p.owner },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const r = res.rows?.[0] ?? null;
    if (!r) return { detail: null };
    return {
      detail: {
        name: r.SYNONYM_NAME,
        owner: r.OWNER,
        targetSchema: r.TABLE_OWNER,
        targetObject: r.TABLE_NAME,
        targetDbLink: r.DB_LINK,
        ddl: r.DDL,
      },
    };
  });
}

export type DbLinkRow = {
  name: string;
  owner: string;
  username: string | null;
  host: string | null;
  created: string | null;
};

export async function dbLinksList(p: {
  owner: string;
}): Promise<{ objects: DbLinkRow[] }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{
        DB_LINK: string;
        OWNER: string;
        USERNAME: string | null;
        HOST: string | null;
        CREATED: Date | null;
      }>(
        `SELECT db_link, owner, username, host, created
           FROM dba_db_links
          WHERE owner = :owner
          ORDER BY db_link`,
        { owner: p.owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      log.info("[schema] db_links source=DBA_DB_LINKS");
      return {
        objects: (res.rows ?? []).map((r) => ({
          name: r.DB_LINK,
          owner: r.OWNER,
          username: r.USERNAME,
          host: r.HOST,
          created: r.CREATED ? r.CREATED.toISOString() : null,
        })),
      };
    } catch (e: any) {
      if (e.errorNum === 942) {
        log.info("[schema] DBA_DB_LINKS not accessible (ORA-00942), fallback to USER_DB_LINKS");
        const res = await conn.execute<{
          DB_LINK: string;
          USERNAME: string | null;
          HOST: string | null;
          CREATED: Date | null;
        }>(
          `SELECT db_link, username, host, created
             FROM user_db_links
            ORDER BY db_link`,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return {
          objects: (res.rows ?? []).map((r) => ({
            name: r.DB_LINK,
            owner: p.owner,
            username: r.USERNAME,
            host: r.HOST,
            created: r.CREATED ? r.CREATED.toISOString() : null,
          })),
        };
      }
      throw e;
    }
  });
}

export async function dbLinkDdl(p: {
  name: string;
}): Promise<{ ddl: string }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{
      DB_LINK: string;
      USERNAME: string | null;
      HOST: string | null;
    }>(
      `SELECT db_link, username, host FROM user_db_links WHERE db_link = :name`,
      { name: p.name },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const r = res.rows?.[0];
    if (!r) return { ddl: `-- DB Link ${p.name} not found in USER_DB_LINKS` };
    const lines = [
      `CREATE DATABASE LINK ${r.DB_LINK}`,
      `  CONNECT TO ${r.USERNAME ?? "<<USERNAME>>"}`,
      `  IDENTIFIED BY "<<REPLACE_WITH_ACTUAL_PASSWORD>>" -- TODO`,
      `  USING '${r.HOST ?? "<<HOST>>"}';`,
      `-- WARNING: Oracle does not expose DB Link passwords.`,
      `-- This DDL is not executable without manual edit.`,
    ];
    return { ddl: lines.join("\n") };
  });
}

// ── Directories ───────────────────────────────────────────────────────────────

export type DirectoryRow = {
  name: string;
  owner: string;
  path: string;
};

export async function directoriesList(): Promise<{ directories: DirectoryRow[] }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{
        DIRECTORY_NAME: string;
        OWNER: string;
        DIRECTORY_PATH: string;
      }>(
        `SELECT directory_name, owner, directory_path
           FROM dba_directories
          ORDER BY directory_name`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      log.info("[schema] directories source=DBA_DIRECTORIES");
      return {
        directories: (res.rows ?? []).map((r) => ({
          name: r.DIRECTORY_NAME,
          owner: r.OWNER,
          path: r.DIRECTORY_PATH,
        })),
      };
    } catch (e: any) {
      if (e.errorNum === 942) {
        log.info("[schema] DBA_DIRECTORIES not accessible (ORA-00942), fallback to ALL_DIRECTORIES");
        const res = await conn.execute<{
          DIRECTORY_NAME: string;
          OWNER: string;
          DIRECTORY_PATH: string;
        }>(
          `SELECT directory_name, owner, directory_path
             FROM all_directories
            ORDER BY directory_name`,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return {
          directories: (res.rows ?? []).map((r) => ({
            name: r.DIRECTORY_NAME,
            owner: r.OWNER,
            path: r.DIRECTORY_PATH,
          })),
        };
      }
      throw e;
    }
  });
}

export type DirectoryGrant = {
  grantee: string;
  privilege: string;
};

export async function directoryDetails(p: {
  name: string;
}): Promise<{ detail: { name: string; owner: string; path: string; grants: DirectoryGrant[] } | null }> {
  return withActiveSession(async (conn) => {
    let base: { name: string; owner: string; path: string } | null = null;
    try {
      const res = await conn.execute<{
        DIRECTORY_NAME: string;
        OWNER: string;
        DIRECTORY_PATH: string;
      }>(
        `SELECT directory_name, owner, directory_path
           FROM dba_directories
          WHERE directory_name = :name`,
        { name: p.name.toUpperCase() },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const r = res.rows?.[0];
      if (!r) return { detail: null };
      base = { name: r.DIRECTORY_NAME, owner: r.OWNER, path: r.DIRECTORY_PATH };
    } catch (e: any) {
      if (e.errorNum === 942) return { detail: null };
      throw e;
    }

    let grants: DirectoryGrant[] = [];
    try {
      const gRes = await conn.execute<{
        GRANTEE: string;
        PRIVILEGE: string;
      }>(
        `SELECT grantee, privilege
           FROM dba_tab_privs
          WHERE table_schema = 'SYS'
            AND table_name = :name
          ORDER BY grantee, privilege`,
        { name: p.name.toUpperCase() },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      grants = (gRes.rows ?? []).map((r) => ({
        grantee: r.GRANTEE,
        privilege: r.PRIVILEGE,
      }));
    } catch (e: any) {
      if (e.errorNum !== 942) throw e;
    }

    return { detail: { ...base, grants } };
  });
}

// ── Queues (AQ) ───────────────────────────────────────────────────────────────

export type QueueRow = {
  name: string;
  owner: string;
  queueTable: string;
  queueType: string;
  maxRetries: number | null;
  retryDelay: number | null;
  retention: number | null;
  userComment: string | null;
  // from ALL_QUEUE_TABLES join
  payloadType: string | null;
};

export async function queuesList(p: {
  owner: string;
}): Promise<{ queues: QueueRow[] }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{
        OWNER: string;
        NAME: string;
        QUEUE_TABLE: string;
        QUEUE_TYPE: string;
        MAX_RETRIES: number | null;
        RETRY_DELAY: number | null;
        RETENTION: number | null;
        USER_COMMENT: string | null;
        PAYLOAD_TYPE: string | null;
      }>(
        `SELECT q.owner, q.name, q.queue_table, q.queue_type,
                q.max_retries, q.retry_delay, q.retention, q.user_comment,
                qt.type AS payload_type
           FROM all_queues q
           LEFT JOIN all_queue_tables qt
             ON qt.owner = q.owner AND qt.queue_table = q.queue_table
          WHERE q.owner = :owner
            AND q.queue_type != 'EXCEPTION_QUEUE'
          ORDER BY q.name`,
        { owner: p.owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      log.info("[schema] queues source=ALL_QUEUES");
      return {
        queues: (res.rows ?? []).map((r) => ({
          name: r.NAME,
          owner: r.OWNER,
          queueTable: r.QUEUE_TABLE,
          queueType: r.QUEUE_TYPE,
          maxRetries: r.MAX_RETRIES,
          retryDelay: r.RETRY_DELAY,
          retention: r.RETENTION,
          userComment: r.USER_COMMENT,
          payloadType: r.PAYLOAD_TYPE,
        })),
      };
    } catch (e: any) {
      if (e.errorNum === 942) {
        log.info("[schema] ALL_QUEUES not accessible (ORA-00942)");
        return { queues: [] };
      }
      throw e;
    }
  });
}

export async function queueDetails(p: {
  owner: string;
  name: string;
}): Promise<{ queue: QueueRow | null }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{
        OWNER: string;
        NAME: string;
        QUEUE_TABLE: string;
        QUEUE_TYPE: string;
        MAX_RETRIES: number | null;
        RETRY_DELAY: number | null;
        RETENTION: number | null;
        USER_COMMENT: string | null;
        PAYLOAD_TYPE: string | null;
      }>(
        `SELECT q.owner, q.name, q.queue_table, q.queue_type,
                q.max_retries, q.retry_delay, q.retention, q.user_comment,
                qt.type AS payload_type
           FROM all_queues q
           LEFT JOIN all_queue_tables qt
             ON qt.owner = q.owner AND qt.queue_table = q.queue_table
          WHERE q.owner = UPPER(:owner) AND q.name = UPPER(:name)`,
        { owner: p.owner, name: p.name },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const r = res.rows?.[0];
      if (!r) return { queue: null };
      return {
        queue: {
          name: r.NAME,
          owner: r.OWNER,
          queueTable: r.QUEUE_TABLE,
          queueType: r.QUEUE_TYPE,
          maxRetries: r.MAX_RETRIES,
          retryDelay: r.RETRY_DELAY,
          retention: r.RETENTION,
          userComment: r.USER_COMMENT,
          payloadType: r.PAYLOAD_TYPE,
        },
      };
    } catch (e: any) {
      if (e.errorNum === 942) return { queue: null };
      throw e;
    }
  });
}

export async function queueDdl(p: {
  owner: string;
  name: string;
}): Promise<{ ddl: string }> {
  return withActiveSession(async (conn) => {
    // Attempt DBMS_METADATA first — may fail with ORA-39200 for system queues.
    try {
      const res = await conn.execute<{ DDL: string }>(
        `SELECT DBMS_METADATA.GET_DDL('AQ_QUEUE', UPPER(:name), UPPER(:owner)) AS ddl FROM dual`,
        { name: p.name, owner: p.owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const ddl = res.rows?.[0]?.DDL;
      if (ddl) return { ddl: String(ddl) };
    } catch (e: any) {
      // ORA-39200 (not supported), ORA-31603 (object not found) — fall through to reconstruction
      if (e.errorNum !== 39200 && e.errorNum !== 31603 && e.errorNum !== 942) throw e;
    }

    // Reconstruct DDL from ALL_QUEUES metadata
    let meta: {
      QUEUE_TABLE: string; QUEUE_TYPE: string;
      MAX_RETRIES: number | null; RETRY_DELAY: number | null;
      RETENTION: number | null; PAYLOAD_TYPE: string | null;
    } | null = null;
    try {
      const mRes = await conn.execute<{
        QUEUE_TABLE: string;
        QUEUE_TYPE: string;
        MAX_RETRIES: number | null;
        RETRY_DELAY: number | null;
        RETENTION: number | null;
        PAYLOAD_TYPE: string | null;
      }>(
        `SELECT q.queue_table, q.queue_type, q.max_retries, q.retry_delay,
                q.retention, qt.type AS payload_type
           FROM all_queues q
           LEFT JOIN all_queue_tables qt
             ON qt.owner = q.owner AND qt.queue_table = q.queue_table
          WHERE q.owner = UPPER(:owner) AND q.name = UPPER(:name)`,
        { owner: p.owner, name: p.name },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      meta = mRes.rows?.[0] ?? null;
    } catch (e: any) {
      if (e.errorNum !== 942) throw e;
    }

    if (!meta) {
      return {
        ddl: `-- Queue ${p.owner}.${p.name}: DDL not available (DBMS_METADATA failed and ALL_QUEUES not accessible).`,
      };
    }

    const lines: string[] = [
      `-- Note: DBMS_METADATA.GET_DDL not available. Reconstructed from ALL_QUEUES metadata.`,
      `BEGIN`,
      `  DBMS_AQADM.CREATE_QUEUE(`,
      `    queue_name         => '${p.owner}.${p.name}',`,
      `    queue_table        => '${p.owner}.${meta.QUEUE_TABLE}',`,
    ];
    if (meta.MAX_RETRIES !== null) lines.push(`    max_retries        => ${meta.MAX_RETRIES},`);
    if (meta.RETRY_DELAY !== null) lines.push(`    retry_delay        => ${meta.RETRY_DELAY},`);
    if (meta.RETENTION !== null) lines.push(`    retention_time     => ${meta.RETENTION},`);
    lines.push(`    queue_type         => DBMS_AQADM.${meta.QUEUE_TYPE}`);
    lines.push(`  );`);
    lines.push(`END;`);
    if (meta.PAYLOAD_TYPE) lines.push(`-- Payload type: ${meta.PAYLOAD_TYPE}`);
    return { ddl: lines.join("\n") };
  });
}

export async function tableDescribe(p: {
  owner: string;
  name: string;
}): Promise<TableDetails> {
  return withActiveSession(async (conn) => {
    const colsRes = await conn.execute<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      DATA_LENGTH: number | null;
      DATA_PRECISION: number | null;
      DATA_SCALE: number | null;
      NULLABLE: string;
      DATA_DEFAULT: string | null;
      COMMENTS: string | null;
      IS_PK: number;
    }>(
      `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
              c.nullable, c.data_default, cc.comments,
              (CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END) AS is_pk
         FROM all_tab_columns c
         LEFT JOIN all_col_comments cc
           ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
         LEFT JOIN (
           SELECT acc.owner, acc.table_name, acc.column_name
             FROM all_constraints ac
             JOIN all_cons_columns acc
               ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
            WHERE ac.constraint_type = 'P'
         ) pk
           ON pk.owner = c.owner AND pk.table_name = c.table_name AND pk.column_name = c.column_name
        WHERE c.owner = :owner AND c.table_name = :name
        ORDER BY c.column_id`,
      { owner: p.owner, name: p.name },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if ((colsRes.rows ?? []).length === 0) {
      throw new RpcCodedError(
        OBJECT_NOT_FOUND,
        `Object ${p.owner}.${p.name} has no columns or does not exist.`
      );
    }

    const columns: ColumnDef[] = (colsRes.rows ?? []).map((r) => ({
      name: r.COLUMN_NAME,
      dataType: formatDataType(r.DATA_TYPE, r.DATA_LENGTH, r.DATA_PRECISION, r.DATA_SCALE),
      nullable: r.NULLABLE === "Y",
      isPk: r.IS_PK === 1,
      dataDefault: r.DATA_DEFAULT === null ? null : String(r.DATA_DEFAULT).trim(),
      comments: r.COMMENTS,
      isVector: r.DATA_TYPE.toUpperCase() === "VECTOR",
    }));

    const idxRes = await conn.execute<{
      INDEX_NAME: string;
      UNIQUENESS: string;
      COLUMNS: string;
    }>(
      `SELECT i.index_name, i.uniqueness,
              LISTAGG(ic.column_name, ',') WITHIN GROUP (ORDER BY ic.column_position) AS columns
         FROM all_indexes i
         JOIN all_ind_columns ic
           ON ic.index_owner = i.owner AND ic.index_name = i.index_name
        WHERE i.table_owner = :owner AND i.table_name = :name
        GROUP BY i.index_name, i.uniqueness
        ORDER BY i.index_name`,
      { owner: p.owner, name: p.name },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const indexes: IndexDef[] = (idxRes.rows ?? []).map((r) => ({
      name: r.INDEX_NAME,
      isUnique: r.UNIQUENESS === "UNIQUE",
      columns: r.COLUMNS.split(","),
    }));

    const cntRes = await conn.execute<{ NUM_ROWS: number | null; LAST_ANALYZED: Date | null }>(
      `SELECT num_rows AS NUM_ROWS, last_analyzed AS LAST_ANALYZED
         FROM all_tables WHERE owner = :owner AND table_name = :name`,
      { owner: p.owner, name: p.name },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rowCount = cntRes.rows?.[0]?.NUM_ROWS ?? null;
    const lastAnalyzedRaw = cntRes.rows?.[0]?.LAST_ANALYZED ?? null;
    const lastAnalyzed = lastAnalyzedRaw ? lastAnalyzedRaw.toISOString() : null;

    return { columns, indexes, rowCount, lastAnalyzed };
  });
}

export type QueryColumn = { name: string; dataType: string };
export type QueryResultRow = unknown[];
export type QueryResult = {
  columns: QueryColumn[];
  rows: QueryResultRow[];
  rowCount: number;
  elapsedMs: number;
  // L3.3 Sprint C Onda 3 — DBMS_OUTPUT is enabled session-wide, drained after
  // every queryExecute. Empty array if the statement produced no output.
  dbmsOutput: string[];
};

// ── In-flight query tracking ─────────────────────────────────────────────────
// At most one query is running at a time on the shared connection.
type RunningQuery = { requestId: string; cancelled: boolean };
let _running: RunningQuery | null = null;

/** Exposed for tests only — allows resetting module-level state. */
export function _resetRunning(): void {
  _running = null;
}

/** Exposed for tests only — allows inspecting current running state. */
export function _getRunning(): RunningQuery | null {
  return _running;
}

function formatColumnType(m: {
  dbTypeName?: string;
  precision?: number | null;
  scale?: number | null;
  byteSize?: number | null;
}): string {
  const t = (m.dbTypeName ?? "UNKNOWN").toUpperCase();
  if (t === "NUMBER") {
    if (m.precision != null && m.scale != null && m.scale > 0) return `NUMBER(${m.precision},${m.scale})`;
    if (m.precision != null) return `NUMBER(${m.precision})`;
    return "NUMBER";
  }
  if (t === "VARCHAR2" || t === "NVARCHAR2" || t === "CHAR" || t === "NCHAR" || t === "RAW") {
    return m.byteSize != null ? `${t}(${m.byteSize})` : t;
  }
  if (t.startsWith("TIMESTAMP")) {
    return m.scale != null ? `TIMESTAMP(${m.scale})` : t;
  }
  return t;
}

function normalizeCell(v: unknown): unknown {
  if (v instanceof Float32Array || v instanceof Float64Array) return Array.from(v);
  if (v instanceof Int8Array || v instanceof Uint8Array) return Array.from(v);
  return v;
}

function isCancelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message || "";
  // node-oracledb thin driver raises ORA-01013 or NJS-018 when break() is called.
  return m.includes("ORA-01013") || m.includes("NJS-018");
}

/**
 * L3.3 Sprint C Onda 3 — Enable DBMS_OUTPUT on the currently-active session.
 *
 * Idempotent: calling DBMS_OUTPUT.ENABLE multiple times on the same session
 * is harmless. Best-effort by design: any failure (no active session, sysdba
 * lockdown, weird PSDPM combo) is swallowed because DBMS_OUTPUT is ergonomic,
 * not load-bearing — query.execute paths still work without it.
 *
 * Called from `workspace.open` after a successful connection so every fresh
 * session has the buffer ready, and exposed as RPC `oracle.session_dbms_output_enable`
 * for the rare case where the renderer wants to re-enable mid-session.
 */
export async function enableDbmsOutputForActiveSession(): Promise<void> {
  try {
    await withActiveSession(async (conn) => {
      await conn.execute(`BEGIN DBMS_OUTPUT.ENABLE(1000000); END;`);
    });
  } catch {
    // Best-effort: DBMS_OUTPUT enable failures must never break the caller.
  }
}

async function drainDbmsOutput(conn: oracledb.Connection): Promise<string[] | null> {
  // Use DBMS_OUTPUT.GET_LINES (plural) — fetches up to numlines per round-trip
  // instead of one-line-per-call. Without this, a procedure that prints 10k
  // lines costs 10k Oracle round-trips (potentially several seconds).
  const BATCH = 100;
  const HARD_CAP = 10_000;
  try {
    const lines: string[] = [];
    let total = 0;
    while (total < HARD_CAP) {
      const r = await conn.execute<{ NUM: number; LINES: string[] }>(
        `DECLARE
           v_lines DBMS_OUTPUT.CHARARR;
           v_num   INTEGER := :requested;
         BEGIN
           DBMS_OUTPUT.GET_LINES(v_lines, v_num);
           :num := v_num;
           :lines := v_lines;
         END;`,
        {
          requested: { dir: oracledb.BIND_IN, type: oracledb.NUMBER, val: BATCH },
          num:       { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
          lines:     {
            dir: oracledb.BIND_OUT,
            type: oracledb.STRING,
            maxArraySize: BATCH,
            maxSize: 32767,
          },
        }
      );
      const ob = r.outBinds as { NUM: number; LINES: string[] | null } | undefined;
      const got = ob?.NUM ?? 0;
      if (got <= 0) break;
      const batchLines = ob?.LINES ?? [];
      for (let i = 0; i < got && lines.length < HARD_CAP; i++) {
        lines.push(batchLines[i] ?? "");
      }
      total += got;
      // If the server returned fewer than we asked, the buffer is drained.
      if (got < BATCH) break;
    }
    return lines;
  } catch (e) {
    log.error(`[drainDbmsOutput]: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Discriminated union for multi-statement server results.
export type ServerStatementResult =
  | { status: "ok";        statementIndex: number; sql: string; elapsedMs: number; columns: QueryColumn[]; rows: unknown[][]; rowCount: number; output: string[] | null }
  | { status: "error";     statementIndex: number; sql: string; elapsedMs: number; error: { code: number; message: string }; output: string[] | null }
  | { status: "cancelled"; statementIndex: number; sql: string; elapsedMs: number; output: null };

// L3.3 Sprint C Onda 3 — Multi-statement results carry a cumulative
// `dbmsOutput` field at the top level (union of every statement's per-stmt
// output, in order). Per-statement `output` is preserved for back-compat.
export type MultiQueryResult = {
  multi: true;
  results: ServerStatementResult[];
  dbmsOutput: string[];
};

// ── Authoritative TX state sync (Item #4) ──────────────────────────────────
// Oracle's DBMS_TRANSACTION.LOCAL_TRANSACTION_ID returns the transaction id
// for the current session, or NULL if no transaction is open. We use it as
// ground truth after every potentially-modifying statement so DDL implicit
// commits, anonymous PL/SQL with internal COMMIT, and lost-session recovery
// all converge on the correct state. Round-trip cost is one extra execute()
// per dml/ddl/plsql/tcl — SELECT is exempt (per Geraldo's design call).
async function fetchOracleTxId(conn: oracledb.Connection): Promise<string | null> {
  try {
    const r = await conn.execute<{ T: string | null }>(
      "SELECT DBMS_TRANSACTION.LOCAL_TRANSACTION_ID AS T FROM DUAL",
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const t = r.rows?.[0]?.T;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

async function syncTxStateAfterStatement(
  conn: oracledb.Connection,
  sql: string,
): Promise<void> {
  const kind = classifySql(sql);
  if (kind !== "dml" && kind !== "ddl" && kind !== "plsql" && kind !== "tcl") return;
  const txId = await fetchOracleTxId(conn);
  if (txId === null) {
    resetTxState();
    return;
  }
  if (kind === "dml" || kind === "ddl" || kind === "plsql") {
    recordTxModifying(kind as TxModifyingType, txId);
  } else {
    setTxId(txId);
  }
}

// oracledb thin mode detects statement type by first keyword (case-sensitive in some versions).
// Passing outFormat/maxRows also signals "this is a query" and can cause the driver to strip
// the trailing `;` from PL/SQL anonymous blocks, producing ORA-06550. Avoid both problems
// by using empty options for any PL/SQL statement.
// Allow leading -- line comments before PL/SQL keywords (splitter may include them).
const PLSQL_EXEC_RE =
  /^(?:[ \t]*--[^\n]*\n)*[ \t]*(?:BEGIN|DECLARE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|PACKAGE(?:\s+BODY)?|TYPE(?:\s+BODY)?))\b/i;
const PLSQL_ANON_RE = /^(?:[ \t]*--[^\n]*\n)*[ \t]*(?:BEGIN|DECLARE)\b/i;

/**
 * Run a single statement against the active session; returns QueryResult.
 *
 * L3.4 Sprint C Onda 3 — SELECT-class statements are executed via cursor
 * (resultSet: true) and fetched in batches of QUERY_STREAM_BATCH rows so we
 * can emit `query.progress` notifications while the result set drains. PL/SQL
 * anonymous blocks, DDL, DML, TCL all stay on the legacy single-shot path
 * (no resultSet — they don't return a streamable row set). The streaming
 * branch transparently falls back to single-shot if the driver/mock returns
 * rows in `r.rows` instead of `r.resultSet` (used by existing unit tests).
 */
async function executeSingleStatement(
  conn: oracledb.Connection,
  sql: string,
  requestId: string,
  fetchAll: boolean = false
): Promise<Omit<QueryResult, "dbmsOutput">> {
  const started = Date.now();
  let r: any;
  const isPlsql = PLSQL_EXEC_RE.test(sql);
  // oracledb Thin mode strips the trailing `;` from anonymous PL/SQL blocks when
  // any options object is passed (including `{}`), causing ORA-06550.
  // Thick mode (OCI) requires the trailing `;` per OCI contract — only strip in Thin.
  const sqlToSend = (PLSQL_ANON_RE.test(sql) && _driverMode === "thin")
    ? sql.replace(/;\s*$/, "")
    : sql;
  // Only SELECT-class statements should stream — they're the ones that produce
  // a row set big enough that progress reporting matters. classifySql() looks
  // at the first non-comment keyword.
  const sqlKind = classifySql(sql);
  const wantsStreaming = !isPlsql && sqlKind === "select";
  try {
    if (isPlsql) {
      // Don't pass a bind array for PL/SQL: thin mode scans the statement body for
      // :name patterns and misidentifies :old/:new trigger references as bind variables.
      r = await conn.execute(sqlToSend);
    } else if (wantsStreaming) {
      // autoCommit: false is the global default but stated explicitly so that DML
      // never commits on its own — the user must use the Commit button.
      // resultSet: true returns a cursor that we drain in QUERY_STREAM_BATCH chunks.
      r = await conn.execute(sqlToSend, [], {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: false,
      });
    } else {
      // DML / DDL / TCL / unknown — keep the original single-shot semantics.
      // maxRows: 0 means unlimited (oracledb convention)
      const opts = fetchAll
        ? { maxRows: 0, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: false }
        : { maxRows: 100, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: false };
      r = await conn.execute(sqlToSend, [], opts);
    }
  } catch (execErr) {
    if (_running?.requestId === requestId && _running.cancelled && isCancelError(execErr)) {
      throw new RpcCodedError(QUERY_CANCELLED, "Cancelled by user");
    }
    throw execErr;
  }

  const meta: any[] = r.metaData ?? [];
  const columns: QueryColumn[] = meta.map((m) => ({
    name: m.name,
    dataType: formatColumnType(m),
  }));

  // Streaming path: drain the cursor in batches, emit throttled progress.
  // r.resultSet is undefined when (a) statement was DDL/DML, (b) the test mock
  // returned rows directly without a resultSet object — fall through to the
  // legacy r.rows path in either case.
  if (wantsStreaming && r.resultSet && typeof r.resultSet.getRows === "function") {
    const cursor = r.resultSet;
    const collected: any[][] = [];
    let lastEmitMs = started;
    let lastEmitRows = 0;
    try {
      while (true) {
        if (_running?.requestId === requestId && _running.cancelled) break;
        const batch: any[][] = await cursor.getRows(QUERY_STREAM_BATCH);
        if (!batch || batch.length === 0) break;
        for (const row of batch) collected.push(row);
        const now = Date.now();
        if (
          now - lastEmitMs >= QUERY_PROGRESS_THROTTLE_MS ||
          collected.length - lastEmitRows >= QUERY_STREAM_BATCH
        ) {
          emitNotification("query.progress", {
            requestId,
            rowsFetched: collected.length,
            elapsedMs: now - started,
          });
          lastEmitMs = now;
          lastEmitRows = collected.length;
        }
        // fetchAll === false caps at the original 100-row limit for parity
        // with the legacy single-shot behaviour. fetchAll === true streams
        // until exhausted.
        if (!fetchAll && collected.length >= 100) break;
      }
    } finally {
      try {
        await cursor.close();
      } catch {
        /* best-effort: cursor close failure must not mask the real error */
      }
    }
    const rows: QueryResultRow[] = collected.map((row) => row.map(normalizeCell));
    return {
      columns,
      rows,
      rowCount: collected.length,
      elapsedMs: Date.now() - started,
    };
  }

  // Legacy single-shot path (DML/DDL/PLSQL/test mocks without resultSet).
  const rawRows: any[][] = r.rows ?? [];
  const rows: QueryResultRow[] = rawRows.map((row) => row.map(normalizeCell));
  const rowCount = rawRows.length > 0 ? rawRows.length : (r.rowsAffected ?? 0);
  return { columns, rows, rowCount, elapsedMs: Date.now() - started };
}

/**
 * L2.1 PSDPM (PL/SQL Developer Parity Mode). When the active connection has
 * PSDPM on, only RPC origins matching {user_typed, user_clicked} may execute
 * SQL — every other code path (AI tools, embed batches, schema pre-fetches,
 * sandbox auto-tasks) is rejected. When PSDPM is off, this is a no-op.
 *
 * The renderer signals origin via the `origin` field on `query.execute` params.
 * If the field is missing (legacy callers), we treat the call as user-initiated
 * to keep existing flows working — Agent D is wiring origin into the params on
 * a sibling branch, and the gate becomes load-bearing once that lands.
 */
export function enforcePsdpmForOrigin(origin: string | undefined): void {
  const safety = getSessionSafety();
  // 4-layer hard-lock Layer 4 (Sprint C): when env=prod, PSDPM is structurally
  // forced ON regardless of the persisted psdpm_mode flag. Even if a tampered
  // SQLite row or stale state leaked through, sidecar refuses non-user origins.
  const envForcesPsdpm = safety?.env === "prod";
  if (safety?.psdpm !== true && !envForcesPsdpm) return;
  const allowed = ["user_typed", "user_clicked"];
  const o = origin ?? "user_typed";
  if (!allowed.includes(o)) {
    throw new RpcCodedError(
      PSDPM_BLOCKED,
      `PSDPM active: only user-initiated statements allowed (origin: ${origin ?? "unspecified"})`
    );
  }
}

/**
 * Apply the read-only and unsafe-DML guards to a single statement.
 * Throws RpcCodedError on block, returns void on pass.
 *
 * Env-calibrated unsafe-DML rules (security item #2):
 *   prod  — TRUNCATE: always blocked (-32040). MERGE/unsafe DML: requires an active
 *            unlock window set via workspace.unlockUnsafeDml (-32039). Window is one-shot.
 *   staging — MERGE/unsafe DML: double-confirm required; caller re-submits with
 *             acknowledgeTable matching the target table name (-32038).
 *   dev/local — original warnUnsafeDml flag: single confirm via acknowledgeUnsafe (-32031).
 */
function enforceSafetyForStatement(
  sql: string,
  opts: { acknowledgeUnsafe?: boolean; acknowledgeTable?: string } = {}
): void {
  const safety = getSessionSafety();
  const kind = classifySql(sql);
  const env = safety.env as string | undefined;

  if (safety.readOnly === true && !isReadOnlySafe(kind, sql)) {
    throw new RpcCodedError(
      READ_ONLY_BLOCKED,
      `This connection is read-only — ${kind.toUpperCase()} statements are blocked. ` +
        `Edit the connection to disable read-only mode if you need to run ${kind.toUpperCase()}.`
    );
  }

  if (env === "prod") {
    if (isTruncateSql(sql)) {
      throw new RpcCodedError(TRUNCATE_PROD_BLOCKED,
        "TRUNCATE is permanently blocked on prod connections. No bypass is available.");
    }
    if (isMergeSql(sql) || isUnsafeBulkDml(sql)) {
      const table = extractTableFromSql(sql);
      const w = _unsafeDmlWindow;
      const now = _clock.now();
      if (w && now < w.expiresAt && w.table === table) {
        _unsafeDmlWindow = null;
        log.info(`[security] UNSAFE_DML_PROD_EXECUTED table=${table}`);
        return;
      }
      throw new RpcCodedError(
        UNSAFE_DML_PROD_BLOCKED,
        `Statement blocked on prod. Call workspace.unlockUnsafeDml with table "${table || "the target table"}" to open a one-shot 15-minute window.`,
        { table }
      );
    }
  } else if (env === "staging") {
    if (isMergeSql(sql) || isUnsafeBulkDml(sql)) {
      const table = extractTableFromSql(sql);
      if (!opts.acknowledgeTable) {
        throw new RpcCodedError(
          UNSAFE_DML_STAGING,
          `This statement will affect all rows in ${table || "the target table"}. Type the table name to confirm.`,
          { table }
        );
      }
      if (opts.acknowledgeTable.toUpperCase() !== table) {
        throw new RpcCodedError(
          UNSAFE_DML_STAGING,
          `Table name mismatch — expected "${table}", got "${opts.acknowledgeTable.toUpperCase()}".`,
          { table }
        );
      }
    }
  } else {
    if (safety.warnUnsafeDml === true && !opts.acknowledgeUnsafe && isUnsafeBulkDml(sql)) {
      throw new RpcCodedError(
        UNSAFE_DML_WARNING,
        "This UPDATE/DELETE has no WHERE clause and will affect ALL rows. " +
          "Confirm you want to run it (the IDE will show a warning modal)."
      );
    }
  }
}

/** Open a one-shot 15-minute unlock window for a specific table on prod. */
export function unlockUnsafeDml(p: { table: string }): { ok: true; expiresAt: number } {
  const safety = getSessionSafety();
  if ((safety.env as string | undefined) !== "prod") {
    throw new RpcCodedError(UNSAFE_DML_PROD_BLOCKED,
      "workspace.unlockUnsafeDml is only available on prod connections.");
  }
  const table = (p.table ?? "").toUpperCase().trim();
  if (!table) {
    throw new RpcCodedError(UNSAFE_DML_PROD_BLOCKED,
      "table is required — pass the fully-qualified target (e.g. HR.EMPLOYEES).");
  }
  const expiresAt = _clock.now() + UNSAFE_DML_WINDOW_TTL_MS;
  _unsafeDmlWindow = { table, expiresAt };
  log.info(`[security] UNSAFE_DML_UNLOCK table=${table} expiresAt=${new Date(expiresAt).toISOString()}`);
  return { ok: true, expiresAt };
}

export async function queryExecute(p: {
  sql: string;
  requestId?: string;
  splitMulti?: boolean;
  fetchAll?: boolean;
  acknowledgeUnsafe?: boolean;
  /** Security item #2: staging double-confirm. The table name the user typed. */
  acknowledgeTable?: string;
  /**
   * L2.1: caller-tagged provenance for the request. Allowed user origins:
   * "user_typed" | "user_clicked". When PSDPM is active any other origin (or
   * a missing origin from a non-user code path) is rejected. Undefined is
   * treated as user-initiated for backwards compatibility — Agent D's branch
   * makes this load-bearing for non-user callers.
   */
  origin?: string;
}): Promise<QueryResult | MultiQueryResult> {
  // L2.1 PSDPM gate runs first so non-user RPCs short-circuit before any
  // session / cancellation bookkeeping touches the connection.
  enforcePsdpmForOrigin(p.origin);
  if (_running !== null) {
    throw new RpcCodedError(ORACLE_ERR, "Another query is already running on this connection");
  }
  // Assign or generate a requestId so cancellation can be matched.
  const requestId = p.requestId ?? crypto.randomUUID();
  _running = { requestId, cancelled: false };

  // ── Multi-statement path ──────────────────────────────────────────────────
  if (p.splitMulti === true) {
    try {
      const { statements, errors } = splitSql(p.sql);
      if (errors.length > 0) {
        const msg = errors.map((e) => `line ${e.line}: ${e.message}`).join("; ");
        throw new RpcCodedError(SPLITTER_ERROR, `Splitter error: ${msg}`);
      }
      if (statements.length === 0) {
        return { multi: true, results: [], dbmsOutput: [] };
      }

      // Enforce read-only / unsafe-DML BEFORE we run anything: if the batch
      // contains a forbidden statement, bail out cleanly so we don't half-execute.
      for (const stmt of statements) {
        enforceSafetyForStatement(stmt, { acknowledgeUnsafe: p.acknowledgeUnsafe, acknowledgeTable: p.acknowledgeTable });
      }

      const collected: ServerStatementResult[] = [];
      // L3.3 — DBMS_OUTPUT.ENABLE is now lifted into workspace.open (and the
      // dedicated oracle.session_dbms_output_enable RPC), so we no longer
      // re-enable it here on every multi-statement run. The drain calls below
      // still capture any output the user's PL/SQL produced.

      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];

        // Check for cancellation between statements.
        if (_running?.requestId === requestId && _running.cancelled) {
          const started = Date.now();
          collected.push({ status: "cancelled", statementIndex: i, sql: stmt, elapsedMs: Date.now() - started, output: null });
          break;
        }

        try {
          let output: string[] | null = null;
          const qr = await withActiveSession(async (conn) => {
            try {
              const result = await executeSingleStatement(conn, stmt, requestId);
              await syncTxStateAfterStatement(conn, stmt);
              return result;
            } finally {
              // Drain even on failure so the next statement starts with an
              // empty buffer. drainDbmsOutput is best-effort internally.
              output = await drainDbmsOutput(conn);
            }
          });
          collected.push({
            status: "ok",
            statementIndex: i,
            sql: stmt,
            elapsedMs: qr.elapsedMs,
            columns: qr.columns,
            rows: qr.rows,
            rowCount: qr.rowCount,
            output,
          });
        } catch (err) {
          if (err instanceof RpcCodedError && err.code === QUERY_CANCELLED) {
            collected.push({ status: "cancelled", statementIndex: i, sql: stmt, elapsedMs: 0, output: null });
          } else {
            const code = err instanceof RpcCodedError ? err.code : (err instanceof Error ? -32013 : -32000);
            const message = err instanceof Error ? err.message : String(err);
            collected.push({ status: "error", statementIndex: i, sql: stmt, elapsedMs: 0, error: { code, message }, output: null });
          }
          break; // Stop on error or cancel
        }
      }

      // Cumulative top-level dbmsOutput is the union of every statement's
      // captured per-stmt output, preserving order. Per-stmt `output` is kept
      // as-is for back-compat with renderer code already shipped.
      const cumulative: string[] = [];
      for (const r of collected) {
        if ("output" in r && Array.isArray(r.output)) {
          for (const line of r.output) cumulative.push(line);
        }
      }
      return { multi: true, results: collected, dbmsOutput: cumulative };
    } finally {
      if (_running?.requestId === requestId) {
        _running = null;
      }
    }
  }

  // ── Single-statement path (default, back-compat) ──────────────────────────
  try {
    enforceSafetyForStatement(p.sql, { acknowledgeUnsafe: p.acknowledgeUnsafe, acknowledgeTable: p.acknowledgeTable });
    return await withActiveSession(async (conn) => {
      let dbmsOutput: string[] = [];
      try {
        const base = await executeSingleStatement(conn, p.sql, requestId, p.fetchAll === true);
        const drained = await drainDbmsOutput(conn);
        dbmsOutput = drained ?? [];
        await syncTxStateAfterStatement(conn, p.sql);
        return { ...base, dbmsOutput };
      } catch (err) {
        // Drain anyway so the buffer is empty for the next query. We can't
        // attach the output to the thrown error (caller doesn't expect it),
        // but draining keeps the session consistent.
        try {
          await drainDbmsOutput(conn);
        } catch {
          /* best-effort */
        }
        throw err;
      }
    });
  } finally {
    if (_running?.requestId === requestId) _running = null;
  }
}

export type QueryCancelResult = { cancelled: true; requestId: string } | { cancelled: false };

export async function queryCancel(p: { requestId: string }): Promise<QueryCancelResult> {
  if (_running === null || _running.requestId !== p.requestId) {
    return { cancelled: false };
  }
  _running.cancelled = true;
  // Interrupt the in-flight call on the shared connection.
  const conn = getActiveSession();
  try {
    await conn.break();
  } catch {
    // break() may fail if the query already completed; that's fine.
  }
  return { cancelled: true, requestId: p.requestId };
}

export type PlsqlKind = "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE BODY" | "TRIGGER" | "TYPE" | "TYPE BODY";
export type CompileErrorRow = { line: number; position: number; text: string };
export type ObjectRefWithStatus = { name: string; status: string };

export async function compileErrors(p: {
  objectType: string;
  objectName: string;
}): Promise<{ errors: CompileErrorRow[] }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{ LINE: number; POSITION: number; TEXT: string }>(
      `SELECT line, position, text
         FROM user_errors
        WHERE name = UPPER(:name)
          AND type = UPPER(:type)
        ORDER BY sequence`,
      { name: p.objectName, type: p.objectType },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return {
      errors: (res.rows ?? []).map((r) => ({
        line: r.LINE,
        position: r.POSITION,
        text: r.TEXT,
      })),
    };
  });
}

export async function objectDdl(p: {
  owner: string;
  objectType: string;
  objectName: string;
}): Promise<{ ddl: string; spec?: string; body?: string }> {
  return withActiveSession(async (conn) => {
    const fetchOpts = {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      fetchTypeHandler: (meta: any) =>
        meta.dbType === oracledb.DB_TYPE_CLOB ? { type: oracledb.STRING } : undefined,
    };

    const specRes = await conn.execute<[string]>(
      `SELECT DBMS_METADATA.GET_DDL(UPPER(:type), UPPER(:name), UPPER(:owner)) FROM dual`,
      { type: p.objectType, name: p.objectName, owner: p.owner },
      fetchOpts
    );
    const rawDdl: string = ((specRes.rows?.[0]?.[0] as string) ?? "").trim();

    if (p.objectType.toUpperCase() === "PACKAGE") {
      // Oracle sometimes returns the combined spec+body when GET_DDL('PACKAGE', ...) is called.
      // Extract just the spec by truncating at the PACKAGE BODY declaration if present.
      const bodyHeaderIdx = rawDdl.search(/\n\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+)?PACKAGE\s+BODY\b/i);
      const specDdl = bodyHeaderIdx !== -1 ? rawDdl.slice(0, bodyHeaderIdx).trim() : rawDdl;

      let bodyDdl = "";
      try {
        const bodyRes = await conn.execute<[string]>(
          `SELECT DBMS_METADATA.GET_DDL('PACKAGE_BODY', UPPER(:name), UPPER(:owner)) FROM dual`,
          { name: p.objectName, owner: p.owner },
          fetchOpts
        );
        bodyDdl = ((bodyRes.rows?.[0]?.[0] as string) ?? "").trim();
      } catch (e) {
        log.warn(`objectDdl body query failed for ${p.owner}.${p.objectName}: ${e}`);
      }
      const combined = bodyDdl
        ? specDdl + "\n\n" + bodyDdl
        : specDdl;
      return { ddl: combined, spec: specDdl, body: bodyDdl || undefined };
    }

    const specDdl = rawDdl;

    return { ddl: specDdl };
  });
}

export async function objectsListPlsql(p: {
  owner: string;
  kind: PlsqlKind;
}): Promise<{ objects: ObjectRefWithStatus[] }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{ NAME: string; STATUS: string }>(
      `SELECT object_name AS NAME, status AS STATUS
         FROM all_objects
        WHERE owner = :owner AND object_type = :kind
        ORDER BY object_name`,
      { owner: p.owner, kind: p.kind },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return {
      objects: (res.rows ?? []).map((r) => ({ name: r.NAME, status: r.STATUS })),
    };
  });
}

export type DataFlowNode = { owner: string; name: string; objectType: string };
export type DataFlowTriggerInfo = { name: string; triggerType: string; event: string; status: string };
export type DataFlowResult = {
  upstream: DataFlowNode[];
  downstream: DataFlowNode[];
  fkParents: DataFlowNode[];
  fkChildren: DataFlowNode[];
  triggers: DataFlowTriggerInfo[];
};

export async function objectDataflow(p: {
  owner: string;
  objectType: string;
  objectName: string;
}): Promise<DataFlowResult> {
  return withActiveSession(async (conn) => {
    const opts = { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 200 };

    // What this object depends on (upstream)
    const upstreamTypes = p.objectType.toUpperCase() === "PACKAGE"
      ? ["PACKAGE", "PACKAGE BODY"]
      : [p.objectType.toUpperCase()];

    const upstreamPlaceholders = upstreamTypes.map((_, i) => `:t${i}`).join(", ");
    const upstreamBinds: Record<string, string> = { owner: p.owner, name: p.objectName };
    upstreamTypes.forEach((t, i) => { upstreamBinds[`t${i}`] = t; });

    const upRes = await conn.execute<[string, string, string]>(
      `SELECT DISTINCT d.referenced_owner, d.referenced_name, d.referenced_type
       FROM all_dependencies d
       WHERE d.owner = UPPER(:owner) AND d.name = UPPER(:name)
         AND d.type IN (${upstreamPlaceholders})
         AND d.referenced_type NOT IN ('NON-EXISTENT', 'UNDEFINED', 'SYNONYM')
         AND NOT (d.referenced_owner = UPPER(:owner) AND d.referenced_name = UPPER(:name))
       ORDER BY d.referenced_type, d.referenced_name`,
      upstreamBinds,
      opts
    );

    // What depends on this object (downstream)
    const dnRes = await conn.execute<[string, string, string]>(
      `SELECT DISTINCT d.owner, d.name, d.type
       FROM all_dependencies d
       WHERE d.referenced_owner = UPPER(:owner) AND d.referenced_name = UPPER(:name)
         AND d.referenced_type = UPPER(:objectType)
         AND NOT (d.owner = UPPER(:owner) AND d.name = UPPER(:name))
       ORDER BY d.type, d.name`,
      { owner: p.owner, name: p.objectName, objectType: p.objectType },
      opts
    );

    const toNode = (row: [string, string, string]): DataFlowNode => ({
      owner: row[0], name: row[1], objectType: row[2],
    });

    const upstream: DataFlowNode[] = (upRes.rows ?? []).map(toNode);
    const downstream: DataFlowNode[] = (dnRes.rows ?? []).map(toNode);

    let fkParents: DataFlowNode[] = [];
    let fkChildren: DataFlowNode[] = [];
    let triggers: DataFlowTriggerInfo[] = [];

    if (p.objectType.toUpperCase() === "TABLE") {
      // FK parents: tables that this table references
      const parRes = await conn.execute<[string, string]>(
        `SELECT DISTINCT cc.owner, cc.table_name
         FROM all_constraints c
         JOIN all_constraints cc ON cc.constraint_name = c.r_constraint_name AND cc.owner = c.r_owner
         WHERE c.table_name = UPPER(:name) AND c.owner = UPPER(:owner) AND c.constraint_type = 'R'
         ORDER BY cc.table_name`,
        { name: p.objectName, owner: p.owner },
        opts
      );
      fkParents = (parRes.rows ?? []).map(r => ({ owner: r[0], name: r[1], objectType: "TABLE" }));

      // FK children: tables that reference this table
      const chRes = await conn.execute<[string, string]>(
        `SELECT DISTINCT c.owner, c.table_name
         FROM all_constraints c
         JOIN all_constraints rc ON rc.constraint_name = c.r_constraint_name AND rc.owner = c.r_owner
         WHERE rc.table_name = UPPER(:name) AND rc.owner = UPPER(:owner) AND c.constraint_type = 'R'
         ORDER BY c.table_name`,
        { name: p.objectName, owner: p.owner },
        opts
      );
      fkChildren = (chRes.rows ?? []).map(r => ({ owner: r[0], name: r[1], objectType: "TABLE" }));

      // Triggers on this table
      const trgRes = await conn.execute<[string, string, string, string]>(
        `SELECT trigger_name, trigger_type, triggering_event, status
         FROM all_triggers
         WHERE table_name = UPPER(:name) AND owner = UPPER(:owner)
         ORDER BY trigger_name`,
        { name: p.objectName, owner: p.owner },
        opts
      );
      triggers = (trgRes.rows ?? []).map(r => ({
        name: r[0], triggerType: r[1], event: r[2], status: r[3],
      }));
    }

    return { upstream, downstream, fkParents, fkChildren, triggers };
  });
}

// ── Table Related ────────────────────────────────────────────────────────────

export type TriggerRef = {
  name: string;
  triggerType: string; // BEFORE/AFTER/INSTEAD OF
  event: string;       // INSERT OR UPDATE OR DELETE
  status: string;      // ENABLED/DISABLED
  forEach: string;     // ROW / STATEMENT
};

export type FkOutgoing = {
  constraintName: string;
  columns: string;
  refOwner: string;
  refTable: string;
  refColumns: string;
  deleteRule: string;
};

export type FkIncoming = {
  fkOwner: string;
  fkTable: string;
  constraintName: string;
  columns: string;
  deleteRule: string;
};

export type Dependent = {
  owner: string;
  name: string;
  type: string;
};

export type CheckConstraint = {
  name: string;
  columns: string;
  condition: string;
  type: string; // C=check, U=unique
  status: string;
};

export type TableGrant = {
  grantor: string;
  grantee: string;
  privilege: string;
  grantable: string;
};

export type TableRelated = {
  triggers: TriggerRef[];
  fksOut: FkOutgoing[];
  fksIn: FkIncoming[];
  dependents: Dependent[];
  constraints: CheckConstraint[];
  grants: TableGrant[];
};

export async function tableRelated(p: {
  owner: string;
  name: string;
}): Promise<TableRelated> {
  return withActiveSession(async (conn) => {
    const opts = { outFormat: oracledb.OUT_FORMAT_OBJECT };
    const b = { owner: p.owner, name: p.name };

    const safe = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
      try { return await fn(); } catch { return []; }
    };

    const [triggers, fksOut, fksIn, dependents, constraints, grants] = await Promise.all([
      safe(async () => {
        const r = await conn.execute<{
          TRIGGER_NAME: string; TRIGGER_TYPE: string;
          TRIGGERING_EVENT: string; STATUS: string; ACTION_TYPE: string;
        }>(
          `SELECT trigger_name, trigger_type, triggering_event, status, action_type
             FROM all_triggers
            WHERE owner = :owner AND table_name = :name
            ORDER BY trigger_name`,
          b, opts
        );
        return (r.rows ?? []).map((x) => ({
          name: x.TRIGGER_NAME, triggerType: x.TRIGGER_TYPE,
          event: x.TRIGGERING_EVENT, status: x.STATUS, forEach: x.ACTION_TYPE,
        }));
      }),

      safe(async () => {
        const r = await conn.execute<{
          CONSTRAINT_NAME: string; COLUMNS: string; REF_OWNER: string;
          REF_TABLE: string; REF_COLUMNS: string; DELETE_RULE: string;
        }>(
          `SELECT ac.constraint_name,
                  LISTAGG(acc.column_name, ', ') WITHIN GROUP (ORDER BY acc.position) AS columns,
                  arc.owner AS ref_owner, arc.table_name AS ref_table,
                  LISTAGG(arcc.column_name, ', ') WITHIN GROUP (ORDER BY arcc.position) AS ref_columns,
                  ac.delete_rule
             FROM all_constraints ac
             JOIN all_cons_columns acc
               ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
             JOIN all_constraints arc
               ON arc.constraint_name = ac.r_constraint_name AND arc.owner = ac.r_owner
             JOIN all_cons_columns arcc
               ON arcc.owner = arc.owner AND arcc.constraint_name = arc.constraint_name
              AND arcc.position = acc.position
            WHERE ac.owner = :owner AND ac.table_name = :name AND ac.constraint_type = 'R'
            GROUP BY ac.constraint_name, arc.owner, arc.table_name, ac.delete_rule
            ORDER BY ac.constraint_name`,
          b, opts
        );
        return (r.rows ?? []).map((x) => ({
          constraintName: x.CONSTRAINT_NAME, columns: x.COLUMNS,
          refOwner: x.REF_OWNER, refTable: x.REF_TABLE,
          refColumns: x.REF_COLUMNS, deleteRule: x.DELETE_RULE,
        }));
      }),

      safe(async () => {
        const r = await conn.execute<{
          FK_OWNER: string; FK_TABLE: string;
          CONSTRAINT_NAME: string; COLUMNS: string; DELETE_RULE: string;
        }>(
          `SELECT ac.owner AS fk_owner, ac.table_name AS fk_table, ac.constraint_name,
                  LISTAGG(acc.column_name, ', ') WITHIN GROUP (ORDER BY acc.position) AS columns,
                  ac.delete_rule
             FROM all_constraints ac
             JOIN all_cons_columns acc
               ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
            WHERE ac.constraint_type = 'R'
              AND ac.r_owner = :owner
              AND ac.r_constraint_name IN (
                SELECT constraint_name FROM all_constraints
                 WHERE owner = :owner AND table_name = :name AND constraint_type = 'P'
              )
            GROUP BY ac.owner, ac.table_name, ac.constraint_name, ac.delete_rule
            ORDER BY ac.table_name, ac.constraint_name`,
          b, opts
        );
        return (r.rows ?? []).map((x) => ({
          fkOwner: x.FK_OWNER, fkTable: x.FK_TABLE,
          constraintName: x.CONSTRAINT_NAME, columns: x.COLUMNS, deleteRule: x.DELETE_RULE,
        }));
      }),

      safe(async () => {
        const r = await conn.execute<{ OWNER: string; NAME: string; TYPE: string }>(
          `SELECT DISTINCT d.owner, d.name, d.type
             FROM all_dependencies d
            WHERE d.referenced_owner = :owner
              AND d.referenced_name = :name
              AND d.referenced_type = 'TABLE'
              AND d.type IN ('VIEW','PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','MATERIALIZED VIEW','TYPE')
              AND NOT (d.owner = :owner AND d.name = :name)
            ORDER BY d.type, d.name`,
          b, opts
        );
        return (r.rows ?? []).map((x) => ({ owner: x.OWNER, name: x.NAME, type: x.TYPE }));
      }),

      safe(async () => {
        const r = await conn.execute<{
          CONSTRAINT_NAME: string; CONSTRAINT_TYPE: string;
          COLUMNS: string; SEARCH_CONDITION: string | null; STATUS: string;
        }>(
          `SELECT ac.constraint_name, ac.constraint_type,
                  NVL(LISTAGG(acc.column_name, ', ') WITHIN GROUP (ORDER BY acc.position), '') AS columns,
                  ac.search_condition_vc AS search_condition,
                  ac.status
             FROM all_constraints ac
             LEFT JOIN all_cons_columns acc
               ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
            WHERE ac.owner = :owner AND ac.table_name = :name
              AND ac.constraint_type IN ('C', 'U')
              AND ac.constraint_name NOT LIKE 'SYS\_C%' ESCAPE '\'
            GROUP BY ac.constraint_name, ac.constraint_type, ac.search_condition_vc, ac.status
            ORDER BY ac.constraint_type, ac.constraint_name`,
          b, opts
        );
        return (r.rows ?? []).map((x) => ({
          name: x.CONSTRAINT_NAME, type: x.CONSTRAINT_TYPE,
          columns: x.COLUMNS, condition: x.SEARCH_CONDITION ?? "", status: x.STATUS,
        }));
      }),

      safe(async () => {
        const r = await conn.execute<{
          GRANTOR: string; GRANTEE: string; PRIVILEGE: string; GRANTABLE: string;
        }>(
          `SELECT grantor, grantee, privilege, grantable
             FROM all_tab_privs
            WHERE table_schema = :owner AND table_name = :name
            ORDER BY grantee, privilege`,
          b, opts
        );
        return (r.rows ?? []).map((x) => ({
          grantor: x.GRANTOR, grantee: x.GRANTEE,
          privilege: x.PRIVILEGE, grantable: x.GRANTABLE,
        }));
      }),
    ]);

    return { triggers, fksOut, fksIn, dependents, constraints, grants };
  });
}

export async function tableCountRows(p: {
  owner: string;
  name: string;
}): Promise<{ count: number }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<[number]>(
      `SELECT COUNT(*) FROM ${quoteIdent(p.owner)}.${quoteIdent(p.name)}`,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    return { count: res.rows?.[0]?.[0] ?? 0 };
  });
}

export async function connectionCommit(): Promise<{ committed: true }> {
  return withActiveSession(async (conn) => {
    await conn.commit();
    resetTxState();
    return { committed: true as const };
  });
}

export async function connectionRollback(): Promise<{ rolledBack: true }> {
  return withActiveSession(async (conn) => {
    await conn.rollback();
    resetTxState();
    return { rolledBack: true as const };
  });
}

// ── connection.txState (Item #4) ────────────────────────────────────────────
// Returns the authoritative state of the active session's open transaction.
// `hasOpenTx` is true iff DBMS_TRANSACTION.LOCAL_TRANSACTION_ID is non-null
// (consulted live when there is cached pending work to verify, or when caller
// requests a forced refresh). `pendingStatements` is the count of mutating
// statements seen since the last commit/rollback/DDL — informational, may
// over-count if a PL/SQL block did internal commits we couldn't observe.
//
// Semantics: callers (window close, tab switch, beforeNavigate) should treat
// `hasOpenTx === true` as "user must decide" and `pendingStatements` as the
// count to surface in the modal ("3 statements pending"). The frontend never
// derives intent from rowCount/columns heuristics — only from this RPC.
export interface ConnectionTxStateResult {
  hasOpenTx: boolean;
  pendingStatements: number;
  lastTxId: string | null;
  lastModifyingAt: number | null;
  lastModifyingType: TxModifyingType | null;
}

export async function connectionTxState(): Promise<ConnectionTxStateResult> {
  if (!hasSession()) {
    return {
      hasOpenTx: false,
      pendingStatements: 0,
      lastTxId: null,
      lastModifyingAt: null,
      lastModifyingType: null,
    };
  }
  const cached = getTxState();
  // If we believe there's pending work, consult Oracle to confirm. The user's
  // session may have been killed server-side, or a PL/SQL block may have done
  // an internal COMMIT we didn't observe via classifySql.
  if (cached.pendingStatements > 0) {
    try {
      const txId = await withActiveSession((conn) => fetchOracleTxId(conn));
      if (txId === null) {
        resetTxState();
      } else {
        setTxId(txId);
      }
    } catch {
      // Best-effort: if the consult fails (e.g. session lost mid-call), fall
      // back to cached state. SESSION_LOST handling will reset us shortly.
    }
  }
  const fresh = getTxState();
  return {
    hasOpenTx: fresh.pendingStatements > 0,
    pendingStatements: fresh.pendingStatements,
    lastTxId: fresh.lastTxId,
    lastModifyingAt: fresh.lastModifyingAt,
    lastModifyingType: fresh.lastModifyingType,
  };
}

export type SearchResult = { owner: string; name: string; type: string };

export async function objectsSearch(p: {
  query: string;
}): Promise<{ objects: SearchResult[] }> {
  return withActiveSession(async (conn) => {
    const q = p.query.trim().toUpperCase();
    if (!q) return { objects: [] };
    const res = await conn.execute<[string, string, string]>(
      `SELECT owner, object_name, object_type
         FROM all_objects
        WHERE object_name LIKE '%' || :q || '%'
          AND object_type IN ('TABLE','VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','TRIGGER','TYPE')
        ORDER BY
          CASE WHEN owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 0 ELSE 1 END,
          CASE WHEN object_name LIKE :q || '%' THEN 0 ELSE 1 END,
          object_name
        FETCH FIRST 50 ROWS ONLY`,
      { q },
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    return {
      objects: (res.rows ?? []).map(([owner, name, type]) => ({ owner, name, type })),
    };
  });
}

export async function schemaKindCounts(p: {
  owner: string;
}): Promise<{ counts: Record<string, number> }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<[string, number]>(
      `SELECT object_type, COUNT(*) AS cnt
         FROM all_objects
        WHERE owner = :owner
          AND object_type IN ('TABLE','VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TRIGGER','TYPE','MATERIALIZED VIEW')
        GROUP BY object_type`,
      { owner: p.owner },
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const counts: Record<string, number> = {};
    for (const [type, cnt] of res.rows ?? []) counts[type] = cnt;
    return { counts };
  });
}

// ── Vector Similarity Search (Oracle 23ai+) ──────────────────────────────────

export type VectorSearchResult = {
  columns: Array<{ name: string }>;
  rows: unknown[][];
  scores: number[];
  vectors?: number[][];
  queryVector?: number[];
};

export async function vectorSimilaritySearch(p: {
  owner: string;
  tableName: string;
  columnName: string;
  vector: number[];
  distanceMetric: "COSINE" | "EUCLIDEAN" | "DOT";
  limit: number;
  withVectors?: boolean;
}): Promise<VectorSearchResult> {
  return withActiveSession(async (conn) => {
    const badIdx = p.vector.findIndex(n => !isFinite(n) || isNaN(n));
    if (badIdx >= 0) throw new Error(`Invalid vector value at index ${badIdx}: ${p.vector[badIdx]}`);
    const vecStr = `[${p.vector.map(n => n.toFixed(8)).join(",")}]`;
    const metric = ["COSINE", "EUCLIDEAN", "DOT"].includes(p.distanceMetric)
      ? p.distanceMetric
      : "COSINE";
    const limit = Math.min(Math.max(1, p.limit), 100);

    const colRes = await conn.execute<{ COLUMN_NAME: string }>(
      `SELECT column_name FROM all_tab_columns
        WHERE owner = :owner AND table_name = :tbl
          AND data_type != 'VECTOR'
        ORDER BY column_id`,
      { owner: p.owner, tbl: p.tableName },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const dataCols = (colRes.rows ?? []).map((r) => r.COLUMN_NAME);
    const colList = dataCols.length > 0
      ? dataCols.map((c) => `t.${quoteIdent(c)}`).join(", ")
      : "t.ROWID";

    const qOwner = quoteIdent(p.owner);
    const qTable = quoteIdent(p.tableName);
    const qCol   = quoteIdent(p.columnName);

    // Optionally include the serialized vector for scatter/PCA
    // Use CLOB to avoid ORA-00910 (VARCHAR2 SQL limit is 4000 bytes; vectors exceed it)
    const vecExtra = p.withVectors
      ? `, FROM_VECTOR(t.${qCol} RETURNING CLOB) AS VEC_STR__`
      : "";

    const sql = `
      SELECT ${colList},
             VECTOR_DISTANCE(t.${qCol}, TO_VECTOR(:vecStr), ${metric}) AS VD_SCORE${vecExtra}
        FROM ${qOwner}.${qTable} t
       WHERE t.${qCol} IS NOT NULL
       ORDER BY VECTOR_DISTANCE(t.${qCol}, TO_VECTOR(:vecStr), ${metric})
       FETCH FIRST ${limit} ROWS ONLY`;

    const res = await conn.execute<unknown[]>(sql, { vecStr: { val: vecStr, type: oracledb.STRING, maxSize: Math.max(16000, vecStr.length + 100) } }, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      fetchTypeHandler: (meta: { name: string }) => {
        if (meta.name === "VEC_STR__") return { type: oracledb.STRING };
      },
    });

    const allCols = (res.metaData ?? []).map((m) => ({ name: m.name }));
    const vecStrIdx = allCols.findIndex(c => c.name === "VEC_STR__");
    const metaCols = allCols.filter(c => c.name !== "VEC_STR__");
    const allRows = (res.rows ?? []) as unknown[][];

    // Strip VEC_STR__ from data rows
    const rows = vecStrIdx >= 0
      ? allRows.map(r => (r as unknown[]).filter((_, i) => i !== vecStrIdx))
      : allRows;

    const scoreIdx = metaCols.findIndex((c) => c.name === "VD_SCORE");
    const scores = rows.map((r) => (scoreIdx >= 0 ? Number((r as unknown[])[scoreIdx]) : 0));

    let vectors: number[][] | undefined;
    if (p.withVectors && vecStrIdx >= 0) {
      vectors = allRows.map(r => {
        const s = String((r as unknown[])[vecStrIdx] ?? "");
        try { return JSON.parse(s) as number[]; } catch { return []; }
      });
    }

    return { columns: metaCols, rows, scores, vectors, queryVector: p.withVectors ? p.vector : undefined };
  });
}

// ── Vector metadata ───────────────────────────────────────────────────────────

export type VectorColumnRef = { tableName: string; columnName: string };

export async function vectorTablesInSchema(p: {
  owner: string;
}): Promise<{ columns: VectorColumnRef[] }> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      `SELECT table_name AS TABLE_NAME, column_name AS COLUMN_NAME
         FROM all_tab_columns
        WHERE owner = :owner AND data_type = 'VECTOR'
        ORDER BY table_name, column_name`,
      { owner: p.owner },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return {
      columns: (res.rows ?? []).map((r) => ({
        tableName: r.TABLE_NAME,
        columnName: r.COLUMN_NAME,
      })),
    };
  });
}

export type VectorIndex = {
  indexName: string;
  targetColumn: string;
  indexType: string;
  distanceMetric: string;
  accuracy: number | null;
  parameters: string | null;
};

export async function vectorIndexList(p: {
  owner: string;
  tableName: string;
}): Promise<{ indexes: VectorIndex[] }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{
        INDEX_NAME: string;
        TARGET_COLUMN: string;
        INDEX_TYPE: string;
        DISTANCE_METRIC: string;
        ACCURACY: number | null;
        PARAMETERS: string | null;
      }>(
        `SELECT index_name AS INDEX_NAME,
                target_column AS TARGET_COLUMN,
                index_type AS INDEX_TYPE,
                distance_metric AS DISTANCE_METRIC,
                accuracy AS ACCURACY,
                parameters AS PARAMETERS
           FROM all_vector_indexes
          WHERE owner = :owner AND target_table = :tableName
          ORDER BY index_name`,
        { owner: p.owner, tableName: p.tableName },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return {
        indexes: (res.rows ?? []).map((r) => ({
          indexName: r.INDEX_NAME,
          targetColumn: r.TARGET_COLUMN,
          indexType: r.INDEX_TYPE,
          distanceMetric: r.DISTANCE_METRIC,
          accuracy: r.ACCURACY,
          parameters: r.PARAMETERS,
        })),
      };
    } catch {
      // ALL_VECTOR_INDEXES doesn't exist on Oracle < 23ai
      return { indexes: [] };
    }
  });
}

// ── Vector Index Management ───────────────────────────────────────────────────

export async function vectorCreateIndex(p: {
  owner: string;
  tableName: string;
  columnName: string;
  indexName: string;
  metric: "COSINE" | "EUCLIDEAN" | "DOT";
  accuracy: number;
  indexType: "hnsw" | "ivf";
}): Promise<{ created: true }> {
  return withActiveSession(async (conn) => {
    const qOwner = quoteIdent(p.owner);
    const qTable = quoteIdent(p.tableName);
    const qCol   = quoteIdent(p.columnName);
    const qIdx   = quoteIdent(p.indexName);
    const metric = ["COSINE", "EUCLIDEAN", "DOT"].includes(p.metric) ? p.metric : "COSINE";
    const accuracy = Math.min(100, Math.max(50, Math.round(p.accuracy)));
    const org = p.indexType === "ivf" ? "NEIGHBOR PARTITIONS" : "INMEMORY NEIGHBOR GRAPH";
    await conn.execute(
      `CREATE VECTOR INDEX ${qIdx} ON ${qOwner}.${qTable}(${qCol})
       ORGANIZATION ${org}
       DISTANCE ${metric}
       WITH TARGET ACCURACY ${accuracy}`
    );
    await conn.commit();
    return { created: true };
  });
}

export async function vectorDropIndex(p: {
  owner: string;
  indexName: string;
}): Promise<{ dropped: true }> {
  return withActiveSession(async (conn) => {
    const qOwner = quoteIdent(p.owner);
    const qIdx   = quoteIdent(p.indexName);
    await conn.execute(`DROP INDEX ${qIdx}`);
    await conn.commit();
    return { dropped: true };
  });
}

// ── Embedding generation ──────────────────────────────────────────────────────

export async function embedCountPending(p: {
  owner: string;
  tableName: string;
  vectorColumn: string;
}): Promise<{ total: number; pending: number }> {
  return withActiveSession(async (conn) => {
    const qOwner = quoteIdent(p.owner);
    const qTable = quoteIdent(p.tableName);
    const qVec   = quoteIdent(p.vectorColumn);
    const res = await conn.execute<[number, number]>(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN ${qVec} IS NULL THEN 1 END) AS pending
         FROM ${qOwner}.${qTable}`,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const row = res.rows?.[0] ?? [0, 0];
    return { total: Number(row[0]), pending: Number(row[1]) };
  });
}

export async function embedBatch(p: {
  owner: string;
  tableName: string;
  textColumn: string;
  vectorColumn: string;
  batchSize: number;
  embed: EmbedParams;
}): Promise<{ embedded: number; errors: number }> {
  return withActiveSession(async (conn) => {
    const qOwner = quoteIdent(p.owner);
    const qTable = quoteIdent(p.tableName);
    const qText  = quoteIdent(p.textColumn);
    const qVec   = quoteIdent(p.vectorColumn);
    const limit  = Math.min(Math.max(1, p.batchSize ?? 20), 200);

    const res = await conn.execute<[string, string]>(
      `SELECT ROWIDTOCHAR(ROWID) AS ROWID_CHAR, ${qText}
         FROM ${qOwner}.${qTable}
        WHERE ${qVec} IS NULL
        FETCH FIRST ${limit} ROWS ONLY`,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );

    const rows = (res.rows ?? []) as [string, string][];
    let embedded = 0;
    let errors = 0;

    for (const [rowid, text] of rows) {
      try {
        const vector = await embedText({ ...p.embed, text: String(text ?? "") });
        const vecStr = `[${vector.map(n => n.toFixed(8)).join(",")}]`;
        await conn.execute(
          `UPDATE ${qOwner}.${qTable} SET ${qVec} = TO_VECTOR(:v) WHERE ROWID = CHARTOROWID(:rowid)`,
          { v: { val: vecStr, type: oracledb.STRING, maxSize: Math.max(16000, vecStr.length + 100) }, rowid }
        );
        embedded++;
      } catch (err) {
        log.error(`[embedBatch] row ${rowid} failed: ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }
    }

    if (embedded > 0) await conn.commit();
    return { embedded, errors };
  });
}

// ── Explain Plan ──────────────────────────────────────────────────────────────

export type ExplainNode = {
  id: number;
  parentId: number | null;
  operation: string;
  options: string | null;
  objectName: string | null;
  objectOwner: string | null;
  cost: number | null;
  cardinality: number | null;
  bytes: number | null;
  accessPredicates: string | null;
  filterPredicates: string | null;
};

export async function explainPlan(p: { sql: string }): Promise<{ nodes: ExplainNode[] }> {
  // Defense in depth: EXPLAIN PLAN concatenates p.sql into the dynamic statement.
  // Reject anything that splits into >1 statement to prevent appended DDL/DML side effects.
  const split = splitSql(p.sql);
  const stmts = split.statements.filter((s) => s.trim().length > 0);
  if (stmts.length === 0) {
    throw { code: -32602, message: "EXPLAIN PLAN: no statement" };
  }
  if (stmts.length > 1) {
    throw { code: -32602, message: "EXPLAIN PLAN: only single-statement queries allowed" };
  }
  // Reject DDL — EXPLAIN PLAN is only for queries and DML.
  const head = stmts[0]
    .replace(/^\s*\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--[^\n]*\n?/g, "")
    .trim()
    .slice(0, 32)
    .toUpperCase();
  if (/^(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|RENAME|BEGIN|DECLARE)\b/.test(head)) {
    throw { code: -32602, message: "EXPLAIN PLAN: only SELECT/INSERT/UPDATE/DELETE/MERGE statements allowed" };
  }
  return withActiveSession(async (conn) => {
    const sid = `V${crypto.randomUUID().replace(/-/g, "").slice(0, 29)}`;
    // EXPLAIN PLAN requires STATEMENT_ID as a string literal — Oracle does not accept a bind variable here (ORA-01780).
    // sid is generated internally so direct interpolation is safe.
    await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${sid}' FOR ${stmts[0]}`);
    let res: oracledb.Result<{
      ID: number;
      PARENT_ID: number | null;
      OPERATION: string;
      OPTIONS: string | null;
      OBJECT_NAME: string | null;
      OBJECT_OWNER: string | null;
      COST: number | null;
      CARDINALITY: number | null;
      BYTES: number | null;
      ACCESS_PREDICATES: string | null;
      FILTER_PREDICATES: string | null;
    }>;
    try {
      res = await conn.execute<{
        ID: number;
        PARENT_ID: number | null;
        OPERATION: string;
        OPTIONS: string | null;
        OBJECT_NAME: string | null;
        OBJECT_OWNER: string | null;
        COST: number | null;
        CARDINALITY: number | null;
        BYTES: number | null;
        ACCESS_PREDICATES: string | null;
        FILTER_PREDICATES: string | null;
      }>(
        `SELECT id               AS ID,
                parent_id        AS PARENT_ID,
                operation        AS OPERATION,
                options          AS OPTIONS,
                object_name      AS OBJECT_NAME,
                object_owner     AS OBJECT_OWNER,
                cost             AS COST,
                cardinality      AS CARDINALITY,
                bytes            AS BYTES,
                access_predicates  AS ACCESS_PREDICATES,
                filter_predicates  AS FILTER_PREDICATES
           FROM plan_table
          WHERE statement_id = :sid
          START WITH id = 0
          CONNECT BY PRIOR id = parent_id
          ORDER SIBLINGS BY id`,
        { sid },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
    } finally {
      await conn.execute(`DELETE FROM plan_table WHERE statement_id = :sid`, { sid });
    }
    const nodes: ExplainNode[] = (res!.rows ?? []).map((r) => ({
      id: r.ID,
      parentId: r.PARENT_ID ?? null,
      operation: r.OPERATION,
      options: r.OPTIONS ?? null,
      objectName: r.OBJECT_NAME ?? null,
      objectOwner: r.OBJECT_OWNER ?? null,
      cost: r.COST ?? null,
      cardinality: r.CARDINALITY ?? null,
      bytes: r.BYTES ?? null,
      accessPredicates: r.ACCESS_PREDICATES ?? null,
      filterPredicates: r.FILTER_PREDICATES ?? null,
    }));
    return { nodes };
  });
}

// ── Procedure / Function Execution ────────────────────────────────────────────

export type ProcParam = {
  name: string;
  position: number;
  direction: "IN" | "OUT" | "IN/OUT";
  dataType: string;
};

async function _procDescribeConn(conn: oracledb.Connection, owner: string, name: string): Promise<ProcParam[]> {
  // ALL_ARGUMENTS without subprogram_id filtering merges overloaded overloads — standalone procedures only.
  const res = await conn.execute<{
    NAME: string;
    POSITION: number;
    DIRECTION: string;
    DATA_TYPE: string;
  }>(
    `SELECT argument_name AS NAME,
            position      AS POSITION,
            in_out        AS DIRECTION,
            data_type     AS DATA_TYPE
       FROM all_arguments
      WHERE owner       = :owner
        AND object_name = :name
        AND data_level  = 0
      ORDER BY position`,
    { owner: owner.toUpperCase(), name: name.toUpperCase() },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  return (res.rows ?? []).map((r) => ({
    name: r.NAME ?? "RETURN",
    position: r.POSITION,
    direction: (r.DIRECTION as ProcParam["direction"]) ?? "IN",
    dataType: r.DATA_TYPE ?? "VARCHAR2",
  }));
}

export async function procDescribe(p: {
  owner: string;
  name: string;
}): Promise<{ params: ProcParam[] }> {
  return withActiveSession(async (conn) => {
    return { params: await _procDescribeConn(conn, p.owner, p.name) };
  });
}

export type ProcExecuteResult = {
  outParams: { name: string; value: string }[];
  refCursors: { name: string; columns: QueryColumn[]; rows: QueryResultRow[] }[];
  dbmsOutput: string[];
};

export function oracleTypeFor(dataType: string): number {
  const t = dataType.toUpperCase();
  if (t.includes("NUMBER") || t.includes("INTEGER") || t.includes("FLOAT")) return oracledb.NUMBER;
  if (t.includes("DATE") || t.includes("TIMESTAMP")) return oracledb.DATE;
  return oracledb.STRING;
}

export function convertInputValue(v: string, dataType: string): unknown {
  if (!v || v.toUpperCase() === "NULL") return null;
  const t = dataType.toUpperCase();
  if (t.includes("NUMBER") || t.includes("INTEGER") || t.includes("FLOAT")) return Number(v);
  if (t.includes("DATE") || t.includes("TIMESTAMP")) return new Date(v);
  return v;
}

export async function dmlPreview(sql: string): Promise<{
  estimatedRows: number | null;
  timedOut: boolean;
  warning?: string;
  tableName?: string;
}> {
  const normalized = sql.trim().replace(/\s+/g, " ");
  const upper = normalized.toUpperCase();

  let tableName: string | null = null;
  let countQuery: string | null = null;

  if (upper.startsWith("MERGE")) {
    return { estimatedRows: null, timedOut: false, warning: "merge-not-analyzable" };
  }
  if (upper.startsWith("TRUNCATE")) {
    const m = normalized.match(/^TRUNCATE\s+(?:TABLE\s+)?([A-Za-z0-9_$#"]+)/i);
    if (m) {
      tableName = m[1];
      countQuery = `SELECT COUNT(*) AS n FROM ${quoteIdent(m[1])}`;
    }
  } else if (upper.startsWith("DELETE")) {
    const m = normalized.match(/^DELETE\s+(?:FROM\s+)?([A-Za-z0-9_$#"]+)(.*)/is);
    if (m) {
      tableName = m[1];
      const rest = (m[2] ?? "").trim();
      const whereMatch = rest.match(/\bWHERE\b.+/is);
      countQuery = whereMatch
        ? `SELECT COUNT(*) AS n FROM ${quoteIdent(m[1])} ${whereMatch[0]}`
        : `SELECT COUNT(*) AS n FROM ${quoteIdent(m[1])}`;
    }
  } else if (upper.startsWith("UPDATE")) {
    const m = normalized.match(/^UPDATE\s+([A-Za-z0-9_$#"]+)\s+SET\b(.+)/is);
    if (m) {
      tableName = m[1];
      const afterSet = m[2] ?? "";
      const whereMatch = afterSet.match(/\bWHERE\b.+/is);
      countQuery = whereMatch
        ? `SELECT COUNT(*) AS n FROM ${quoteIdent(m[1])} ${whereMatch[0]}`
        : `SELECT COUNT(*) AS n FROM ${quoteIdent(m[1])}`;
    }
  }

  if (!countQuery) {
    return { estimatedRows: null, timedOut: false, warning: "parse-failed", tableName: tableName ?? undefined };
  }

  try {
    const result = await withActiveSession(async (conn) => {
      const prevTimeout = conn.callTimeout;
      conn.callTimeout = 5000;
      try {
        const r = await conn.execute(countQuery!, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          maxRows: 1,
        });
        const row = (r.rows as Record<string, unknown>[] | undefined)?.[0];
        return row ? Number(row["N"]) : null;
      } finally {
        conn.callTimeout = prevTimeout;
      }
    });
    return { estimatedRows: result, timedOut: false, tableName: tableName ?? undefined };
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e);
    if (/DPI-1067|callTimeout|timed out/i.test(msg)) {
      return { estimatedRows: null, timedOut: true, tableName: tableName ?? undefined };
    }
    return { estimatedRows: null, timedOut: false, warning: "query-failed", tableName: tableName ?? undefined };
  }
}

export async function procExecute(p: {
  owner: string;
  name: string;
  params: { name: string; value: string }[];
}): Promise<ProcExecuteResult> {
  return withActiveSession(async (conn) => {
    const paramMeta = await _procDescribeConn(conn, p.owner, p.name);

    const binds: Record<string, oracledb.BindDefinition> = {};
    const callArgs: string[] = [];

    // Defense in depth: pm.name comes from ALL_ARGUMENTS but a malicious DBA could in theory
    // store an identifier with dollar/hash combinations that, while legal Oracle, would behave
    // oddly when concatenated below. Reject anything outside a strict Oracle identifier shape.
    const ORACLE_IDENT_RE = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/;

    for (const pm of paramMeta) {
      if (!ORACLE_IDENT_RE.test(pm.name)) {
        throw { code: -32602, message: `Invalid parameter name from ALL_ARGUMENTS: ${pm.name}` };
      }
      const isRefCursor = pm.dataType === "REF CURSOR";
      if (pm.direction === "IN") {
        const v = p.params.find((x) => x.name === pm.name);
        binds[`i_${pm.name}`] = {
          dir: oracledb.BIND_IN,
          val: convertInputValue(v?.value ?? "", pm.dataType),
        };
        callArgs.push(`${pm.name} => :i_${pm.name}`);
      } else if (pm.direction === "OUT" && !isRefCursor) {
        binds[`o_${pm.name}`] = {
          dir: oracledb.BIND_OUT,
          type: oracleTypeFor(pm.dataType),
          maxSize: 32767,
        };
        callArgs.push(`${pm.name} => :o_${pm.name}`);
      } else if (pm.direction === "OUT" && isRefCursor) {
        binds[`o_${pm.name}`] = { dir: oracledb.BIND_OUT, type: oracledb.CURSOR };
        callArgs.push(`${pm.name} => :o_${pm.name}`);
      } else if (pm.direction === "IN/OUT") {
        const v = p.params.find((x) => x.name === pm.name);
        binds[`io_${pm.name}`] = {
          dir: oracledb.BIND_INOUT,
          val: convertInputValue(v?.value ?? "", pm.dataType),
          type: oracleTypeFor(pm.dataType),
          maxSize: 32767,
        };
        callArgs.push(`${pm.name} => :io_${pm.name}`);
      }
    }

    const callExpr = `${quoteIdent(p.owner)}.${quoteIdent(p.name)}(${callArgs.join(", ")})`;
    const block = `BEGIN ${callExpr}; END;`;

    await conn.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
    const result = await conn.execute(block, binds, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
    });
    const ob = (result.outBinds ?? {}) as Record<string, unknown>;

    const outParams: { name: string; value: string }[] = [];
    const refCursors: { name: string; columns: QueryColumn[]; rows: QueryResultRow[] }[] = [];

    for (const pm of paramMeta) {
      const isRefCursor = pm.dataType === "REF CURSOR";
      if (pm.direction === "OUT" && !isRefCursor) {
        const val = ob[`o_${pm.name}`];
        outParams.push({
          name: pm.name,
          value: val === null || val === undefined ? "NULL" : String(val),
        });
      } else if (pm.direction === "IN/OUT") {
        const val = ob[`io_${pm.name}`];
        outParams.push({
          name: pm.name,
          value: val === null || val === undefined ? "NULL" : String(val),
        });
      } else if (pm.direction === "OUT" && isRefCursor) {
        const rs = ob[`o_${pm.name}`] as oracledb.ResultSet<unknown[]> | null;
        if (rs) {
          const meta = (rs.metaData ?? []) as Array<{ name: string; fetchType?: number }>;
          const columns: QueryColumn[] = meta.map((m) => ({
            name: m.name,
            dataType: formatColumnType(m as any),
          }));
          const rows: unknown[][] = [];
          let row: unknown[] | undefined;
          let rowCount = 0;
          while ((row = (await rs.getRow()) as unknown[] | undefined) && rowCount < 1000) {
            rows.push(row.map(normalizeCell));
            rowCount++;
          }
          await rs.close();
          refCursors.push({ name: pm.name, columns, rows });
        } else {
          refCursors.push({ name: pm.name, columns: [], rows: [] });
        }
      }
    }

    const dbmsOutput = (await drainDbmsOutput(conn)) ?? [];
    return { outParams, refCursors, dbmsOutput };
  });
}

// ── V$SESSION self-viewer (Sprint C Onda 2 — L3.1) ───────────────────────────

export type SessionSelfRow = {
  sid: number;
  serial: number;
  username: string | null;
  osuser: string | null;
  machine: string | null;
  program: string | null;
  logonTime: string;
  module: string | null;
  action: string | null;
  clientInfo: string | null;
  clientIdentifier: string | null;
  status: string;
  state: string;
  event: string | null;
  sqlId: string | null;
  blockingSession?: number;
  blockingSessionStatus?: string;
};

const SESSION_SELF_SQL = `
  SELECT
    sid,
    serial# AS serial_num,
    username,
    osuser,
    machine,
    program,
    TO_CHAR(logon_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS logon_time,
    module,
    action,
    client_info,
    client_identifier,
    status,
    state,
    event,
    sql_id,
    blocking_session,
    blocking_session_status
  FROM v$session
  WHERE audsid = SYS_CONTEXT('USERENV', 'SESSIONID')
    AND audsid != 0
`;

export async function querySessionSelf(): Promise<SessionSelfRow> {
  const conn = getActiveSession();
  let result: any;

  try {
    result = await conn.execute(SESSION_SELF_SQL, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
  } catch (err: any) {
    const oraNum = typeof err?.errorNum === "number" ? err.errorNum : null;

    if (oraNum === 942) {
      throw new RpcCodedError(
        SESSION_SELF_PRIV_MISSING,
        "Missing SELECT privilege on V$SESSION",
        {
          kind: "missing_privilege",
          grant: "GRANT SELECT ON V_$SESSION TO <user>;",
        },
      );
    }

    const transientData: Record<string, unknown> = { kind: "transient" };
    if (oraNum !== null) {
      transientData.oracleCode = oraNum;
    }
    throw new RpcCodedError(
      SESSION_SELF_TRANSIENT,
      err?.message ?? "Oracle error querying V$SESSION",
      transientData,
    );
  }

  const row = result?.rows?.[0];
  if (!row) {
    throw new RpcCodedError(
      SESSION_SELF_NOT_FOUND,
      "V$SESSION returned no row for current AUDSID",
      { kind: "session_self_not_found" },
    );
  }

  const out: SessionSelfRow = {
    sid: Number(row.SID),
    serial: Number(row.SERIAL_NUM),
    username: row.USERNAME ?? null,
    osuser: row.OSUSER ?? null,
    machine: row.MACHINE ?? null,
    program: row.PROGRAM ?? null,
    logonTime: String(row.LOGON_TIME),
    module: row.MODULE ?? null,
    action: row.ACTION ?? null,
    clientInfo: row.CLIENT_INFO ?? null,
    clientIdentifier: row.CLIENT_IDENTIFIER ?? null,
    status: String(row.STATUS),
    state: String(row.STATE),
    event: row.EVENT ?? null,
    sqlId: row.SQL_ID ?? null,
  };

  if (row.BLOCKING_SESSION != null) {
    out.blockingSession = Number(row.BLOCKING_SESSION);
    out.blockingSessionStatus = row.BLOCKING_SESSION_STATUS ?? undefined;
  }

  return out;
}

// ── Item #1B T1B.1 — Scheduler Jobs ──────────────────────────────────────────

export type SchedulerJobRow = {
  owner: string;
  name: string;
  jobType: string | null;
  state: string;
  enabled: boolean;
  runCount: number;
  failureCount: number;
  nextRunDate: string | null;
  scheduleName: string | null;
  programName: string | null;
  comments: string | null;
};

export type LegacyJobRow = {
  jobId: number;
  owner: string;
  jobAction: string | null;
  nextDate: string | null;
  broken: boolean;
  failures: number;
  interval: string | null;
};

export type SchedulerJobDetails = {
  owner: string;
  name: string;
  jobType: string | null;
  jobAction: string | null;
  state: string;
  enabled: boolean;
  runCount: number;
  failureCount: number;
  maxFailures: number | null;
  retryCount: number | null;
  maxRuns: number | null;
  lastRunDuration: string | null;
  nextRunDate: string | null;
  startDate: string | null;
  endDate: string | null;
  scheduleName: string | null;
  scheduleType: string | null;
  repeatInterval: string | null;
  programName: string | null;
  programType: string | null;
  jobClass: string | null;
  restartable: boolean;
  loggingLevel: string | null;
  comments: string | null;
};

export type LegacyJobDetails = {
  jobId: number;
  owner: string;
  jobAction: string | null;
  nextDate: string | null;
  nextSec: string | null;
  broken: boolean;
  failures: number;
  interval: string | null;
  lastDate: string | null;
  lastSec: string | null;
};

export type SchedulerProgramDetails = {
  owner: string;
  programName: string;
  programType: string;
  programAction: string;
  numberOfArguments: number;
  enabled: boolean;
  comments: string | null;
};

export type SchedulerScheduleDetails = {
  owner: string;
  scheduleName: string;
  scheduleType: string;
  startDate: string | null;
  repeatInterval: string | null;
  endDate: string | null;
  comments: string | null;
};

export type SchedulerJobPrivs = {
  hasCreateAnyJob: boolean;
  hasManageScheduler: boolean;
};

export async function schedulerJobsList(p: {
  owner: string;
}): Promise<{ jobs: SchedulerJobRow[]; legacyJobs: LegacyJobRow[] }> {
  return withActiveSession(async (conn) => {
    const [schedulerResult, legacyResult] = await Promise.allSettled([
      (async (): Promise<SchedulerJobRow[]> => {
        let res: { rows: Record<string, unknown>[] };
        try {
          res = await conn.execute<Record<string, unknown>>(
            `SELECT j.OWNER, j.JOB_NAME, j.JOB_TYPE, j.STATE,
                    j.ENABLED, j.RUN_COUNT, j.FAILURE_COUNT,
                    j.NEXT_RUN_DATE, j.SCHEDULE_NAME, j.PROGRAM_NAME,
                    j.COMMENTS
             FROM DBA_SCHEDULER_JOBS j
             WHERE j.OWNER = :owner
             ORDER BY j.JOB_NAME
             FETCH FIRST 500 ROWS ONLY`,
            { owner: p.owner },
          );
        } catch (err: unknown) {
          const oraNum = (err as { errorNum?: number }).errorNum;
          if (oraNum === 942) {
            log.info("[schema] DBA_SCHEDULER_JOBS not accessible (ORA-00942), trying ALL_SCHEDULER_JOBS");
            res = await conn.execute<Record<string, unknown>>(
              `SELECT j.OWNER, j.JOB_NAME, j.JOB_TYPE, j.STATE,
                      j.ENABLED, j.RUN_COUNT, j.FAILURE_COUNT,
                      j.NEXT_RUN_DATE, j.SCHEDULE_NAME, j.PROGRAM_NAME,
                      j.COMMENTS
               FROM ALL_SCHEDULER_JOBS j
               WHERE j.OWNER = :owner
               ORDER BY j.JOB_NAME
               FETCH FIRST 500 ROWS ONLY`,
              { owner: p.owner },
            );
          } else {
            throw err;
          }
        }
        return (res.rows ?? []).map((r) => ({
          owner: String(r.OWNER),
          name: String(r.JOB_NAME),
          jobType: r.JOB_TYPE != null ? String(r.JOB_TYPE) : null,
          state: String(r.STATE),
          enabled: r.ENABLED === "TRUE" || r.ENABLED === true,
          runCount: Number(r.RUN_COUNT ?? 0),
          failureCount: Number(r.FAILURE_COUNT ?? 0),
          nextRunDate: r.NEXT_RUN_DATE != null ? String(r.NEXT_RUN_DATE) : null,
          scheduleName: r.SCHEDULE_NAME != null ? String(r.SCHEDULE_NAME) : null,
          programName: r.PROGRAM_NAME != null ? String(r.PROGRAM_NAME) : null,
          comments: r.COMMENTS != null ? String(r.COMMENTS) : null,
        }));
      })(),
      (async (): Promise<LegacyJobRow[]> => {
        let res: { rows: Record<string, unknown>[] };
        try {
          res = await conn.execute<Record<string, unknown>>(
            `SELECT JOB, SCHEMA_USER AS OWNER, WHAT AS JOB_ACTION,
                    NEXT_DATE, BROKEN, FAILURES, INTERVAL
             FROM DBA_JOBS
             WHERE SCHEMA_USER = :owner
             ORDER BY JOB
             FETCH FIRST 500 ROWS ONLY`,
            { owner: p.owner },
          );
        } catch (err: unknown) {
          const oraNum = (err as { errorNum?: number }).errorNum;
          if (oraNum === 942) {
            log.info("[schema] DBA_JOBS not accessible (ORA-00942), trying USER_JOBS");
            try {
              res = await conn.execute<Record<string, unknown>>(
                `SELECT JOB, :owner AS OWNER, WHAT AS JOB_ACTION,
                        NEXT_DATE, BROKEN, FAILURES, INTERVAL
                 FROM USER_JOBS
                 ORDER BY JOB
                 FETCH FIRST 500 ROWS ONLY`,
                { owner: p.owner },
              );
            } catch {
              log.info("[schema] USER_JOBS also not accessible, legacy jobs silently empty");
              return [];
            }
          } else {
            throw err;
          }
        }
        return (res.rows ?? []).map((r) => ({
          jobId: Number(r.JOB),
          owner: String(r.OWNER),
          jobAction: r.JOB_ACTION != null ? String(r.JOB_ACTION) : null,
          nextDate: r.NEXT_DATE != null ? String(r.NEXT_DATE) : null,
          broken: r.BROKEN === "Y" || r.BROKEN === true,
          failures: Number(r.FAILURES ?? 0),
          interval: r.INTERVAL != null ? String(r.INTERVAL) : null,
        }));
      })(),
    ]);

    const jobs = schedulerResult.status === "fulfilled" ? schedulerResult.value : [];
    const legacyJobs = legacyResult.status === "fulfilled" ? legacyResult.value : [];

    if (schedulerResult.status === "rejected") {
      log.warn(`[schema] schedulerJobsList scheduler query failed: ${schedulerResult.reason}`);
    }
    if (legacyResult.status === "rejected") {
      log.warn(`[schema] schedulerJobsList legacy query failed: ${legacyResult.reason}`);
    }

    return { jobs, legacyJobs };
  });
}

export async function schedulerJobDetails(p: {
  owner: string;
  name: string;
}): Promise<{ job: SchedulerJobDetails | null }> {
  return withActiveSession(async (conn) => {
    let res: { rows: Record<string, unknown>[] };
    try {
      res = await conn.execute<Record<string, unknown>>(
        `SELECT j.OWNER, j.JOB_NAME, j.JOB_TYPE, j.JOB_ACTION,
                j.STATE, j.ENABLED, j.RUN_COUNT, j.FAILURE_COUNT,
                j.MAX_FAILURES, j.RETRY_COUNT, j.MAX_RUNS,
                j.LAST_RUN_DURATION, j.NEXT_RUN_DATE,
                j.START_DATE, j.END_DATE,
                j.SCHEDULE_NAME, j.SCHEDULE_TYPE, j.REPEAT_INTERVAL,
                j.PROGRAM_NAME, j.PROGRAM_TYPE,
                j.JOB_CLASS, j.RESTARTABLE, j.LOGGING_LEVEL, j.COMMENTS
         FROM DBA_SCHEDULER_JOBS j
         WHERE j.OWNER = :owner AND j.JOB_NAME = :name`,
        { owner: p.owner, name: p.name },
      );
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942) {
        res = await conn.execute<Record<string, unknown>>(
          `SELECT j.OWNER, j.JOB_NAME, j.JOB_TYPE, j.JOB_ACTION,
                  j.STATE, j.ENABLED, j.RUN_COUNT, j.FAILURE_COUNT,
                  j.MAX_FAILURES, j.RETRY_COUNT, j.MAX_RUNS,
                  j.LAST_RUN_DURATION, j.NEXT_RUN_DATE,
                  j.START_DATE, j.END_DATE,
                  j.SCHEDULE_NAME, j.SCHEDULE_TYPE, j.REPEAT_INTERVAL,
                  j.PROGRAM_NAME, j.PROGRAM_TYPE,
                  j.JOB_CLASS, j.RESTARTABLE, j.LOGGING_LEVEL, j.COMMENTS
           FROM ALL_SCHEDULER_JOBS j
           WHERE j.OWNER = :owner AND j.JOB_NAME = :name`,
          { owner: p.owner, name: p.name },
        );
      } else {
        throw new RpcCodedError(ORACLE_ERR, (err as Error)?.message ?? "Oracle error querying scheduler job details");
      }
    }

    const r = res.rows?.[0];
    if (!r) return { job: null };

    return {
      job: {
        owner: String(r.OWNER),
        name: String(r.JOB_NAME),
        jobType: r.JOB_TYPE != null ? String(r.JOB_TYPE) : null,
        jobAction: r.JOB_ACTION != null ? String(r.JOB_ACTION) : null,
        state: String(r.STATE),
        enabled: r.ENABLED === "TRUE" || r.ENABLED === true,
        runCount: Number(r.RUN_COUNT ?? 0),
        failureCount: Number(r.FAILURE_COUNT ?? 0),
        maxFailures: r.MAX_FAILURES != null ? Number(r.MAX_FAILURES) : null,
        retryCount: r.RETRY_COUNT != null ? Number(r.RETRY_COUNT) : null,
        maxRuns: r.MAX_RUNS != null ? Number(r.MAX_RUNS) : null,
        lastRunDuration: r.LAST_RUN_DURATION != null ? String(r.LAST_RUN_DURATION) : null,
        nextRunDate: r.NEXT_RUN_DATE != null ? String(r.NEXT_RUN_DATE) : null,
        startDate: r.START_DATE != null ? String(r.START_DATE) : null,
        endDate: r.END_DATE != null ? String(r.END_DATE) : null,
        scheduleName: r.SCHEDULE_NAME != null ? String(r.SCHEDULE_NAME) : null,
        scheduleType: r.SCHEDULE_TYPE != null ? String(r.SCHEDULE_TYPE) : null,
        repeatInterval: r.REPEAT_INTERVAL != null ? String(r.REPEAT_INTERVAL) : null,
        programName: r.PROGRAM_NAME != null ? String(r.PROGRAM_NAME) : null,
        programType: r.PROGRAM_TYPE != null ? String(r.PROGRAM_TYPE) : null,
        jobClass: r.JOB_CLASS != null ? String(r.JOB_CLASS) : null,
        restartable: r.RESTARTABLE === "TRUE" || r.RESTARTABLE === true,
        loggingLevel: r.LOGGING_LEVEL != null ? String(r.LOGGING_LEVEL) : null,
        comments: r.COMMENTS != null ? String(r.COMMENTS) : null,
      },
    };
  });
}

export async function legacyJobDetails(p: {
  jobId: number;
  owner: string;
}): Promise<{ job: LegacyJobDetails | null }> {
  return withActiveSession(async (conn) => {
    let res: { rows: Record<string, unknown>[] };
    try {
      res = await conn.execute<Record<string, unknown>>(
        `SELECT JOB, SCHEMA_USER AS OWNER, WHAT AS JOB_ACTION,
                NEXT_DATE, NEXT_SEC, BROKEN, FAILURES,
                INTERVAL, LAST_DATE, LAST_SEC
         FROM DBA_JOBS
         WHERE JOB = :job_id`,
        { job_id: p.jobId },
      );
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942) {
        res = await conn.execute<Record<string, unknown>>(
          `SELECT JOB, :owner AS OWNER, WHAT AS JOB_ACTION,
                  NEXT_DATE, NEXT_SEC, BROKEN, FAILURES,
                  INTERVAL, LAST_DATE, LAST_SEC
           FROM USER_JOBS
           WHERE JOB = :job_id`,
          { owner: p.owner, job_id: p.jobId },
        );
      } else {
        throw new RpcCodedError(ORACLE_ERR, (err as Error)?.message ?? "Oracle error querying legacy job details");
      }
    }

    const r = res.rows?.[0];
    if (!r) return { job: null };

    return {
      job: {
        jobId: Number(r.JOB),
        owner: String(r.OWNER),
        jobAction: r.JOB_ACTION != null ? String(r.JOB_ACTION) : null,
        nextDate: r.NEXT_DATE != null ? String(r.NEXT_DATE) : null,
        nextSec: r.NEXT_SEC != null ? String(r.NEXT_SEC) : null,
        broken: r.BROKEN === "Y" || r.BROKEN === true,
        failures: Number(r.FAILURES ?? 0),
        interval: r.INTERVAL != null ? String(r.INTERVAL) : null,
        lastDate: r.LAST_DATE != null ? String(r.LAST_DATE) : null,
        lastSec: r.LAST_SEC != null ? String(r.LAST_SEC) : null,
      },
    };
  });
}

export async function schedulerJobDdl(p: {
  owner: string;
  name: string;
  legacy?: boolean;
}): Promise<{ ddl: string }> {
  if (p.legacy) {
    return {
      ddl: `-- Legacy DBMS_JOB — DDL not available.\n-- DBMS_JOB jobs are not supported by DBMS_METADATA.\n-- Job ID: ${p.name.replace(/^LEGACY_/, "")}`,
    };
  }

  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<{ DDL: string }>(
        `SELECT DBMS_METADATA.GET_DDL('PROCOBJ', UPPER(:name), UPPER(:owner)) AS ddl FROM dual`,
        { name: p.name, owner: p.owner },
      );
      const ddl = res.rows?.[0]?.DDL;
      if (!ddl) {
        return { ddl: `-- ${p.owner}.${p.name}: DDL not available (DBMS_METADATA returned empty).` };
      }
      return { ddl };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 31603 || oraNum === 39200 || oraNum === 31604) {
        return {
          ddl: `-- ${p.owner}.${p.name}: DDL not available via DBMS_METADATA (ORA-${oraNum}).\n-- The job may not be supported by DBMS_METADATA on this Oracle version.`,
        };
      }
      throw new RpcCodedError(ORACLE_ERR, (err as Error)?.message ?? "Oracle error fetching job DDL");
    }
  });
}

export async function schedulerProgramDetails(p: {
  owner: string;
  programName: string;
}): Promise<{ program: SchedulerProgramDetails | null }> {
  return withActiveSession(async (conn) => {
    let res: { rows: Record<string, unknown>[] };
    try {
      res = await conn.execute<Record<string, unknown>>(
        `SELECT OWNER, PROGRAM_NAME, PROGRAM_TYPE, PROGRAM_ACTION,
                NUMBER_OF_ARGUMENTS, ENABLED, COMMENTS
         FROM DBA_SCHEDULER_PROGRAMS
         WHERE OWNER = :owner AND PROGRAM_NAME = :program_name`,
        { owner: p.owner, program_name: p.programName },
      );
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942) {
        try {
          res = await conn.execute<Record<string, unknown>>(
            `SELECT OWNER, PROGRAM_NAME, PROGRAM_TYPE, PROGRAM_ACTION,
                    NUMBER_OF_ARGUMENTS, ENABLED, COMMENTS
             FROM ALL_SCHEDULER_PROGRAMS
             WHERE OWNER = :owner AND PROGRAM_NAME = :program_name`,
            { owner: p.owner, program_name: p.programName },
          );
        } catch {
          return { program: null };
        }
      } else {
        throw new RpcCodedError(ORACLE_ERR, (err as Error)?.message ?? "Oracle error querying scheduler program");
      }
    }

    const r = res.rows?.[0];
    if (!r) return { program: null };

    return {
      program: {
        owner: String(r.OWNER),
        programName: String(r.PROGRAM_NAME),
        programType: String(r.PROGRAM_TYPE),
        programAction: String(r.PROGRAM_ACTION),
        numberOfArguments: Number(r.NUMBER_OF_ARGUMENTS ?? 0),
        enabled: r.ENABLED === "TRUE" || r.ENABLED === true,
        comments: r.COMMENTS != null ? String(r.COMMENTS) : null,
      },
    };
  });
}

export async function schedulerScheduleDetails(p: {
  owner: string;
  scheduleName: string;
}): Promise<{ schedule: SchedulerScheduleDetails | null }> {
  return withActiveSession(async (conn) => {
    let res: { rows: Record<string, unknown>[] };
    try {
      res = await conn.execute<Record<string, unknown>>(
        `SELECT OWNER, SCHEDULE_NAME, SCHEDULE_TYPE,
                START_DATE, REPEAT_INTERVAL, END_DATE, COMMENTS
         FROM DBA_SCHEDULER_SCHEDULES
         WHERE OWNER = :owner AND SCHEDULE_NAME = :schedule_name`,
        { owner: p.owner, schedule_name: p.scheduleName },
      );
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942) {
        try {
          res = await conn.execute<Record<string, unknown>>(
            `SELECT OWNER, SCHEDULE_NAME, SCHEDULE_TYPE,
                    START_DATE, REPEAT_INTERVAL, END_DATE, COMMENTS
             FROM ALL_SCHEDULER_SCHEDULES
             WHERE OWNER = :owner AND SCHEDULE_NAME = :schedule_name`,
            { owner: p.owner, schedule_name: p.scheduleName },
          );
        } catch {
          return { schedule: null };
        }
      } else {
        throw new RpcCodedError(ORACLE_ERR, (err as Error)?.message ?? "Oracle error querying scheduler schedule");
      }
    }

    const r = res.rows?.[0];
    if (!r) return { schedule: null };

    return {
      schedule: {
        owner: String(r.OWNER),
        scheduleName: String(r.SCHEDULE_NAME),
        scheduleType: String(r.SCHEDULE_TYPE),
        startDate: r.START_DATE != null ? String(r.START_DATE) : null,
        repeatInterval: r.REPEAT_INTERVAL != null ? String(r.REPEAT_INTERVAL) : null,
        endDate: r.END_DATE != null ? String(r.END_DATE) : null,
        comments: r.COMMENTS != null ? String(r.COMMENTS) : null,
      },
    };
  });
}

export async function schedulerJobPrivCheck(): Promise<SchedulerJobPrivs> {
  return withActiveSession(async (conn) => {
    const res = await conn.execute<{ HAS_CREATE_ANY_JOB: number; HAS_MANAGE_SCHEDULER: number }>(
      `SELECT
         MAX(CASE WHEN PRIVILEGE = 'CREATE ANY JOB'   THEN 1 ELSE 0 END) AS has_create_any_job,
         MAX(CASE WHEN PRIVILEGE = 'MANAGE SCHEDULER' THEN 1 ELSE 0 END) AS has_manage_scheduler
       FROM SESSION_PRIVS
       WHERE PRIVILEGE IN ('CREATE ANY JOB', 'MANAGE SCHEDULER')`,
    );
    const r = res.rows?.[0];
    return {
      hasCreateAnyJob: Number(r?.HAS_CREATE_ANY_JOB ?? 0) === 1,
      hasManageScheduler: Number(r?.HAS_MANAGE_SCHEDULER ?? 0) === 1,
    };
  });
}

function validateOracleIdentifier(value: string, label: string): void {
  if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(value)) {
    throw new RpcCodedError(INVALID_IDENTIFIER, `Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

export async function schedulerJobRun(p: {
  owner: string;
  name: string;
  confirmedProdRun?: boolean;
}): Promise<{ ok: true; durationMs: number }> {
  validateOracleIdentifier(p.owner, "owner");
  validateOracleIdentifier(p.name, "job name");

  return withActiveSession(async (conn) => {
    const safety = getSessionSafety();
    const envReal = (safety.env as string | undefined) ?? "unknown";

    if (envReal === "prod" && !p.confirmedProdRun) {
      throw new RpcCodedError(
        JOB_RUN_PROD_REQUIRES_CONFIRMATION,
        `scheduler.job.run on prod requires confirmedProdRun=true. ` +
        `The UI must display the PROD confirmation dialog before calling this RPC.`,
      );
    }

    const start = Date.now();
    await conn.execute(
      `BEGIN DBMS_SCHEDULER.RUN_JOB(:owner || '.' || :name, use_current_session => FALSE); END;`,
      { owner: p.owner, name: p.name },
    );
    const durationMs = Date.now() - start;
    log.info(`[scheduler] run_job owner=${p.owner} name=${p.name} env=${envReal} durationMs=${durationMs}`);
    return { ok: true, durationMs };
  });
}

export async function schedulerJobEnable(p: {
  owner: string;
  name: string;
}): Promise<{ ok: true }> {
  validateOracleIdentifier(p.owner, "owner");
  validateOracleIdentifier(p.name, "job name");

  return withActiveSession(async (conn) => {
    await conn.execute(
      `BEGIN DBMS_SCHEDULER.ENABLE(:owner || '.' || :name); END;`,
      { owner: p.owner, name: p.name },
    );
    log.info(`[scheduler] enable owner=${p.owner} name=${p.name}`);
    return { ok: true };
  });
}

export async function schedulerJobDisable(p: {
  owner: string;
  name: string;
  confirmedProdDisable?: boolean;
}): Promise<{ ok: true }> {
  validateOracleIdentifier(p.owner, "owner");
  validateOracleIdentifier(p.name, "job name");

  return withActiveSession(async (conn) => {
    const safety = getSessionSafety();
    const envReal = (safety.env as string | undefined) ?? "unknown";

    if (envReal === "prod" && !p.confirmedProdDisable) {
      throw new RpcCodedError(
        JOB_DISABLE_PROD_REQUIRES_CONFIRMATION,
        `scheduler.job.disable on prod requires confirmedProdDisable=true. ` +
        `The UI must display the PROD confirmation dialog before calling this RPC.`,
      );
    }

    await conn.execute(
      `BEGIN DBMS_SCHEDULER.DISABLE(:owner || '.' || :name); END;`,
      { owner: p.owner, name: p.name },
    );
    log.info(`[scheduler] disable owner=${p.owner} name=${p.name} env=${envReal}`);
    return { ok: true };
  });
}

export async function dbmsJobRun(p: { jobId: number }): Promise<{ ok: true }> {
  return withActiveSession(async (conn) => {
    await conn.execute(`BEGIN DBMS_JOB.RUN(:job_id); END;`, { job_id: p.jobId });
    log.info(`[scheduler] dbms_job.run jobId=${p.jobId}`);
    return { ok: true };
  });
}

export async function dbmsJobBroken(p: { jobId: number }): Promise<{ ok: true }> {
  return withActiveSession(async (conn) => {
    await conn.execute(`BEGIN DBMS_JOB.BROKEN(:job_id, TRUE); END;`, { job_id: p.jobId });
    log.info(`[scheduler] dbms_job.broken jobId=${p.jobId}`);
    return { ok: true };
  });
}

export async function dbmsJobUnbroken(p: { jobId: number }): Promise<{ ok: true }> {
  return withActiveSession(async (conn) => {
    await conn.execute(`BEGIN DBMS_JOB.BROKEN(:job_id, FALSE, SYSDATE); END;`, { job_id: p.jobId });
    log.info(`[scheduler] dbms_job.unbroken jobId=${p.jobId}`);
    return { ok: true };
  });
}

// ── Item #1C T1C.1: Users ─────────────────────────────────────────────────────

export type UserDetails = {
  username: string;
  accountStatus: string;
  lockDate: string | null;
  expiryDate: string | null;
  created: string;
  profile: string | null;
  authenticationType: string | null;
  defaultTablespace: string | null;
  temporaryTablespace: string | null;
  fallbackMode: boolean;
};

export type ProfileRow = {
  resourceName: string;
  resourceType: string;
  limit: string;
};

export type QuotaRow = {
  tablespaceName: string;
  bytes: number | null;
  maxBytes: number | null;
  blocks: number | null;
  maxBlocks: number | null;
};

// ── Item #1C T1C.2: Sessions ──────────────────────────────────────────────────

export type SessionRow = {
  sid: number;
  serial: number;
  status: string;
  username: string | null;
  osuser: string | null;
  machine: string | null;
  program: string | null;
  module: string | null;
  logonTime: string | null;
  lastCallEt: number | null;
  blockingSession: number | null;
  blockingSessionStatus: string | null;
  waitClass: string | null;
  event: string | null;
  secondsInWait: number | null;
  sqlId: string | null;
};

// ── Item #1C T1C.4: Privileges (types declared here, functions in T1C.4) ──────

export type RolePrivRow = {
  grantedRole: string;
  adminOption: string;
  defaultRole: string;
};

export type SysPrivRow = {
  privilege: string;
  adminOption: string;
};

export type TabPrivRow = {
  owner: string;
  tableName: string;
  grantor: string | null;
  privilege: string;
  grantable: string;
  hierarchy: string | null;
};

export type GrantedToRow = {
  grantee: string;
  tableName: string;
  privilege: string;
  grantable: string;
};

export type PrivilegesList = {
  rolePrivs: RolePrivRow[];
  sysPrivs: SysPrivRow[];
  tabPrivs: TabPrivRow[];
  grantedTo: GrantedToRow[];
  tabPrivsAccessDenied: boolean;
  grantedToAccessDenied: boolean;
  fallbackMode: boolean;
};

// ── Item #1C T1C.5: Blocking chain ───────────────────────────────────────────

export type BlockingPair = {
  blockedSid: number;
  blockedSerial: number;
  blockedUser: string | null;
  waitClass: string | null;
  event: string | null;
  secondsInWait: number | null;
  blockerSid: number;
  blockerSerial: number;
  blockerUser: string | null;
  blockerStatus: string | null;
};

export async function userDetails(p: { username: string }): Promise<UserDetails | null> {
  return withActiveSession(async (conn) => {
    let r: Record<string, unknown> | undefined;
    let fallbackMode = false;
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT USERNAME, ACCOUNT_STATUS, LOCK_DATE, EXPIRY_DATE,
                CREATED, PROFILE, AUTHENTICATION_TYPE,
                DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE
         FROM DBA_USERS
         WHERE USERNAME = :username
         FETCH FIRST 1 ROWS ONLY`,
        { username: p.username },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      r = res.rows?.[0];
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) {
        fallbackMode = true;
        const res = await conn.execute<Record<string, unknown>>(
          `SELECT USERNAME, CREATED FROM ALL_USERS WHERE USERNAME = :username FETCH FIRST 1 ROWS ONLY`,
          { username: p.username },
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        r = res.rows?.[0];
      } else {
        throw err;
      }
    }
    if (!r) return null;
    return {
      username: String(r.USERNAME ?? ""),
      accountStatus: r.ACCOUNT_STATUS != null ? String(r.ACCOUNT_STATUS) : "",
      lockDate: r.LOCK_DATE != null ? String(r.LOCK_DATE) : null,
      expiryDate: r.EXPIRY_DATE != null ? String(r.EXPIRY_DATE) : null,
      created: r.CREATED != null ? String(r.CREATED) : "",
      profile: r.PROFILE != null ? String(r.PROFILE) : null,
      authenticationType: r.AUTHENTICATION_TYPE != null ? String(r.AUTHENTICATION_TYPE) : null,
      defaultTablespace: r.DEFAULT_TABLESPACE != null ? String(r.DEFAULT_TABLESPACE) : null,
      temporaryTablespace: r.TEMPORARY_TABLESPACE != null ? String(r.TEMPORARY_TABLESPACE) : null,
      fallbackMode,
    };
  });
}

export async function userProfileDetails(p: { profile: string }): Promise<{ rows: ProfileRow[]; accessDenied: boolean }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT RESOURCE_NAME, RESOURCE_TYPE, LIMIT
         FROM DBA_PROFILES
         WHERE PROFILE = :profile
         ORDER BY RESOURCE_TYPE, RESOURCE_NAME`,
        { profile: p.profile },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      return {
        rows: (res.rows ?? []).map((r) => ({
          resourceName: String(r.RESOURCE_NAME ?? ""),
          resourceType: String(r.RESOURCE_TYPE ?? ""),
          limit: String(r.LIMIT ?? ""),
        })),
        accessDenied: false,
      };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) return { rows: [], accessDenied: true };
      throw err;
    }
  });
}

export async function userQuotas(p: { username: string }): Promise<{ quotas: QuotaRow[]; accessDenied: boolean }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT TABLESPACE_NAME, BYTES, MAX_BYTES, BLOCKS, MAX_BLOCKS
         FROM DBA_TS_QUOTAS
         WHERE USERNAME = :username
         ORDER BY TABLESPACE_NAME`,
        { username: p.username },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      return {
        quotas: (res.rows ?? []).map((r) => ({
          tablespaceName: String(r.TABLESPACE_NAME ?? ""),
          bytes: r.BYTES != null ? Number(r.BYTES) : null,
          maxBytes: r.MAX_BYTES != null ? Number(r.MAX_BYTES) : null,
          blocks: r.BLOCKS != null ? Number(r.BLOCKS) : null,
          maxBlocks: r.MAX_BLOCKS != null ? Number(r.MAX_BLOCKS) : null,
        })),
        accessDenied: false,
      };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) return { quotas: [], accessDenied: true };
      throw err;
    }
  });
}

export async function sessionsListAll(): Promise<{ sessions: SessionRow[]; accessDenied: boolean }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT
           s.SID, s.SERIAL# AS SERIAL_NUM, s.STATUS, s.USERNAME, s.OSUSER,
           s.MACHINE, s.PROGRAM, s.MODULE,
           TO_CHAR(s.LOGON_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS LOGON_TIME,
           s.LAST_CALL_ET,
           s.BLOCKING_SESSION, s.BLOCKING_SESSION_STATUS,
           s.WAIT_CLASS, s.EVENT, s.SECONDS_IN_WAIT,
           s.SQL_ID
         FROM V$SESSION s
         WHERE s.USERNAME IS NOT NULL
           AND s.TYPE = 'USER'
         ORDER BY s.STATUS DESC, s.LAST_CALL_ET DESC
         FETCH FIRST 200 ROWS ONLY`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      return {
        sessions: (res.rows ?? []).map((r) => ({
          sid: Number(r.SID),
          serial: Number(r.SERIAL_NUM),
          status: String(r.STATUS ?? ""),
          username: r.USERNAME != null ? String(r.USERNAME) : null,
          osuser: r.OSUSER != null ? String(r.OSUSER) : null,
          machine: r.MACHINE != null ? String(r.MACHINE) : null,
          program: r.PROGRAM != null ? String(r.PROGRAM) : null,
          module: r.MODULE != null ? String(r.MODULE) : null,
          logonTime: r.LOGON_TIME != null ? String(r.LOGON_TIME) : null,
          lastCallEt: r.LAST_CALL_ET != null ? Number(r.LAST_CALL_ET) : null,
          blockingSession: r.BLOCKING_SESSION != null ? Number(r.BLOCKING_SESSION) : null,
          blockingSessionStatus: r.BLOCKING_SESSION_STATUS != null ? String(r.BLOCKING_SESSION_STATUS) : null,
          waitClass: r.WAIT_CLASS != null ? String(r.WAIT_CLASS) : null,
          event: r.EVENT != null ? String(r.EVENT) : null,
          secondsInWait: r.SECONDS_IN_WAIT != null ? Number(r.SECONDS_IN_WAIT) : null,
          sqlId: r.SQL_ID != null ? String(r.SQL_ID) : null,
        })),
        accessDenied: false,
      };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) return { sessions: [], accessDenied: true };
      throw err;
    }
  });
}

export async function sessionSqlPreview(p: { sqlId: string }): Promise<{ sql: string | null }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT SUBSTR(SQL_FULLTEXT, 1, 500) AS SQL_PREVIEW
         FROM V$SQL
         WHERE SQL_ID = :sql_id
         AND ROWNUM = 1`,
        { sql_id: p.sqlId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const r = res.rows?.[0];
      return { sql: r?.SQL_PREVIEW != null ? String(r.SQL_PREVIEW) : null };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) return { sql: null };
      throw err;
    }
  });
}

export async function sessionPrivCheck(): Promise<{ hasAlterSystem: boolean }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT COUNT(*) AS HAS_ALTER_SYSTEM
         FROM SESSION_PRIVS
         WHERE PRIVILEGE = 'ALTER SYSTEM'`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const r = res.rows?.[0];
      return { hasAlterSystem: Number(r?.HAS_ALTER_SYSTEM ?? 0) === 1 };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) return { hasAlterSystem: false };
      throw err;
    }
  });
}

export async function sessionKill(p: {
  sid: number;
  serial: number;
  confirmedProdKill?: boolean;
}): Promise<{ ok: true }> {
  // Ajuste 1: positive integer validation
  const sid = Math.trunc(p.sid);
  const serial = Math.trunc(p.serial);
  if (!Number.isInteger(sid) || !Number.isInteger(serial) || sid <= 0 || serial <= 0) {
    throw new RpcCodedError(INVALID_SESSION_ID, "SID and SERIAL# must be positive integers");
  }
  // Ajuste 1: upper bound — Oracle NUMBER(11) practical max
  const MAX_SESSION_ID = 2147483647;
  if (sid > MAX_SESSION_ID || serial > MAX_SESSION_ID) {
    throw new RpcCodedError(INVALID_SESSION_ID, "SID/SERIAL# exceeds valid range");
  }

  return withActiveSession(async (conn) => {
    // T1A.8 env guard (3rd replication — after mview.refresh and job.run)
    const env = (getSessionSafety().env as string | undefined) ?? "unknown";
    if (env === "prod" && !p.confirmedProdKill) {
      throw new RpcCodedError(
        SESSION_KILL_PROD_REQUIRES_CONFIRMATION,
        "Killing sessions in prod requires explicit confirmation",
      );
    }

    // Ajuste 2: refuse to kill SYS/SYSTEM — killing either can destabilize the instance.
    // ORA-942/1031 on the lookup means we can't verify the target is safe → refuse.
    let username: string | null = null;
    try {
      const targetRes = await conn.execute<Record<string, unknown>>(
        `SELECT USERNAME FROM V$SESSION WHERE SID = :sid AND SERIAL# = :serial`,
        { sid, serial },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const rawUser = targetRes.rows?.[0]?.USERNAME;
      username = rawUser != null ? String(rawUser).toUpperCase() : null;
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) {
        throw new RpcCodedError(
          INVALID_SESSION_ID,
          "Cannot verify session target: insufficient privilege on V$SESSION",
        );
      }
      throw err;
    }
    if (username === "SYS" || username === "SYSTEM") {
      throw new RpcCodedError(
        INVALID_SESSION_ID,
        `Refusing to kill ${username} session — protected system user`,
      );
    }

    // Oracle KILL SESSION requires numeric literals in the quoted string; bind variables are not
    // supported for the session address. SID and SERIAL# are validated as positive integers above.
    await conn.execute(`ALTER SYSTEM KILL SESSION '${sid},${serial}' IMMEDIATE`);
    log.info(`[session] kill sid=${sid} serial=${serial} env=${env}`);
    return { ok: true };
  });
}

export async function privilegesList(p: { schema: string }): Promise<PrivilegesList> {
  return withActiveSession(async (conn) => {
    let fallbackMode = false;

    // Role Privs: DBA_ROLE_PRIVS → SESSION_ROLES fallback on ORA-942/1031
    let rolePrivs: RolePrivRow[] = [];
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE
         FROM DBA_ROLE_PRIVS
         WHERE GRANTEE = :schema
         ORDER BY GRANTED_ROLE`,
        { schema: p.schema },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      rolePrivs = (res.rows ?? []).map((r) => ({
        grantedRole: String(r.GRANTED_ROLE ?? ""),
        adminOption: String(r.ADMIN_OPTION ?? "NO"),
        defaultRole: String(r.DEFAULT_ROLE ?? "NO"),
      }));
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) {
        fallbackMode = true;
        try {
          const res = await conn.execute<Record<string, unknown>>(
            `SELECT ROLE AS GRANTED_ROLE, 'NO' AS ADMIN_OPTION, 'YES' AS DEFAULT_ROLE
             FROM SESSION_ROLES ORDER BY ROLE`,
            {},
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
          );
          rolePrivs = (res.rows ?? []).map((r) => ({
            grantedRole: String(r.GRANTED_ROLE ?? ""),
            adminOption: String(r.ADMIN_OPTION ?? "NO"),
            defaultRole: String(r.DEFAULT_ROLE ?? "YES"),
          }));
        } catch { rolePrivs = []; }
      } else {
        throw err;
      }
    }

    // Sys Privs: DBA_SYS_PRIVS → SESSION_PRIVS fallback on ORA-942/1031
    let sysPrivs: SysPrivRow[] = [];
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT PRIVILEGE, ADMIN_OPTION
         FROM DBA_SYS_PRIVS
         WHERE GRANTEE = :schema
         ORDER BY PRIVILEGE`,
        { schema: p.schema },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      sysPrivs = (res.rows ?? []).map((r) => ({
        privilege: String(r.PRIVILEGE ?? ""),
        adminOption: String(r.ADMIN_OPTION ?? "NO"),
      }));
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) {
        fallbackMode = true;
        try {
          const res = await conn.execute<Record<string, unknown>>(
            `SELECT PRIVILEGE, 'NO' AS ADMIN_OPTION FROM SESSION_PRIVS ORDER BY PRIVILEGE`,
            {},
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
          );
          sysPrivs = (res.rows ?? []).map((r) => ({
            privilege: String(r.PRIVILEGE ?? ""),
            adminOption: String(r.ADMIN_OPTION ?? "NO"),
          }));
        } catch { sysPrivs = []; }
      } else {
        throw err;
      }
    }

    // Tab Privs received: DBA_TAB_PRIVS WHERE GRANTEE = schema
    let tabPrivs: TabPrivRow[] = [];
    let tabPrivsAccessDenied = false;
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT OWNER, TABLE_NAME, GRANTOR, PRIVILEGE, GRANTABLE, HIERARCHY
         FROM DBA_TAB_PRIVS
         WHERE GRANTEE = :schema
         ORDER BY OWNER, TABLE_NAME, PRIVILEGE
         FETCH FIRST 200 ROWS ONLY`,
        { schema: p.schema },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      tabPrivs = (res.rows ?? []).map((r) => ({
        owner: String(r.OWNER ?? ""),
        tableName: String(r.TABLE_NAME ?? ""),
        grantor: r.GRANTOR != null ? String(r.GRANTOR) : null,
        privilege: String(r.PRIVILEGE ?? ""),
        grantable: String(r.GRANTABLE ?? "NO"),
        hierarchy: r.HIERARCHY != null ? String(r.HIERARCHY) : null,
      }));
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) { tabPrivsAccessDenied = true; }
      else throw err;
    }

    // Granted To others: DBA_TAB_PRIVS WHERE OWNER = schema
    let grantedTo: GrantedToRow[] = [];
    let grantedToAccessDenied = false;
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT GRANTEE, TABLE_NAME, PRIVILEGE, GRANTABLE
         FROM DBA_TAB_PRIVS
         WHERE OWNER = :schema
         ORDER BY GRANTEE, TABLE_NAME, PRIVILEGE
         FETCH FIRST 200 ROWS ONLY`,
        { schema: p.schema },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      grantedTo = (res.rows ?? []).map((r) => ({
        grantee: String(r.GRANTEE ?? ""),
        tableName: String(r.TABLE_NAME ?? ""),
        privilege: String(r.PRIVILEGE ?? ""),
        grantable: String(r.GRANTABLE ?? "NO"),
      }));
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) { grantedToAccessDenied = true; }
      else throw err;
    }

    return { rolePrivs, sysPrivs, tabPrivs, grantedTo, tabPrivsAccessDenied, grantedToAccessDenied, fallbackMode };
  });
}

export async function blockingChain(): Promise<{ pairs: BlockingPair[]; accessDenied: boolean }> {
  return withActiveSession(async (conn) => {
    try {
      const res = await conn.execute<Record<string, unknown>>(
        `SELECT s1.SID AS BLOCKED_SID, s1.SERIAL# AS BLOCKED_SERIAL,
                s1.USERNAME AS BLOCKED_USER, s1.WAIT_CLASS AS WAIT_CLASS,
                s1.EVENT AS EVENT, s1.SECONDS_IN_WAIT AS SECONDS_IN_WAIT,
                s2.SID AS BLOCKER_SID, s2.SERIAL# AS BLOCKER_SERIAL,
                s2.USERNAME AS BLOCKER_USER, s2.STATUS AS BLOCKER_STATUS
         FROM V$SESSION s1
         JOIN V$SESSION s2 ON s1.BLOCKING_SESSION = s2.SID
         WHERE s1.BLOCKING_SESSION IS NOT NULL
         ORDER BY s2.SID, s1.SID
         FETCH FIRST 50 ROWS ONLY`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const pairs: BlockingPair[] = (res.rows ?? []).map((r) => ({
        blockedSid: Number(r.BLOCKED_SID),
        blockedSerial: Number(r.BLOCKED_SERIAL),
        blockedUser: r.BLOCKED_USER != null ? String(r.BLOCKED_USER) : null,
        waitClass: r.WAIT_CLASS != null ? String(r.WAIT_CLASS) : null,
        event: r.EVENT != null ? String(r.EVENT) : null,
        secondsInWait: r.SECONDS_IN_WAIT != null ? Number(r.SECONDS_IN_WAIT) : null,
        blockerSid: Number(r.BLOCKER_SID),
        blockerSerial: Number(r.BLOCKER_SERIAL),
        blockerUser: r.BLOCKER_USER != null ? String(r.BLOCKER_USER) : null,
        blockerStatus: r.BLOCKER_STATUS != null ? String(r.BLOCKER_STATUS) : null,
      }));
      return { pairs, accessDenied: false };
    } catch (err: unknown) {
      const oraNum = (err as { errorNum?: number }).errorNum;
      if (oraNum === 942 || oraNum === 1031) return { pairs: [], accessDenied: true };
      throw err;
    }
  });
}
