// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// src/lib/stores/sql-editor.svelte.ts
import { queryExecute, queryExecuteMulti, queryCancel, type QueryResult, type SqlOrigin } from "$lib/sql-query";
import { splitSql } from "$lib/sql-splitter";
import { historySave, type HistoryEntry } from "$lib/query-history";
import { saveAs, saveExisting, openFile } from "$lib/sql-files";
import { compileErrorsGet, connectionCommit, connectionRollback, connectionTxState, explainPlanGet, type ProcExecuteResult, type Result, type TxStateView } from "$lib/workspace";
import { detectDestructive, type DestructiveOp } from "$lib/sql-safety";
import { objectVersionCapture } from "$lib/object-versions";
import { CloudAuditService } from "$lib/services/CloudAuditService";
import { toasts } from "$lib/stores/toasts.svelte";
import type { SharedExecResult } from "$lib/command/types";

export type CompileError = {
  line: number;
  position: number;
  text: string;
};

export type TabResult = {
  id: string;                         // crypto.randomUUID for selection stability
  statementIndex: number;             // 0-based; for display as "Statement N+1"
  sqlPreview: string;                 // first ~80 chars of the statement, single line
  sqlOriginal: string | null;         // full SQL of the statement (for re-execution / Fetch All)
  status: "ok" | "error" | "cancelled" | "running" | "explain" | "commit" | "rollback";
  result: QueryResult | null;
  error: { code: number; message: string } | null;
  elapsedMs: number;                  // 0 while running
  dbmsOutput: string[] | null;        // null = not captured; [] = enabled but nothing printed
  compileErrors: CompileError[] | null; // null = not a compilable stmt; [] = clean
  explainNodes: import("$lib/workspace").ExplainNode[] | null;
  explainError?: string;
  fetchedAll: boolean;                // true if the result came from a fetchAll run (no row cap)
};

export type PlsqlMeta = {
  connectionId: string;
  owner: string;
  objectType: string;
  objectName: string;
};

export type SqlTab = {
  id: string;
  kind: "sql" | "command";            // "sql" = Monaco editor; "command" = Command Window (xterm)
  title: string;
  sql: string;
  results: TabResult[];               // replaces `result` + `error`
  activeResultId: string | null;      // which result is shown in the grid
  running: boolean;                   // still useful for the tab badge / cancel overlay
  runningRequestId: string | null;    // for cancel
  splitterError: string | null;       // if the splitter emitted errors, show banner
  filePath: string | null;            // null = never saved
  isDirty: boolean;                   // true when sql !== savedContent
  savedContent: string | null;        // content at last save/load; null if new tab
  plsqlMeta: PlsqlMeta | null;
  packageSpec: string | undefined;
  packageActiveTab: "spec" | "body" | undefined;
  specMeta: PlsqlMeta | undefined;
  connectionId: string | null;        // captured at tab creation; only set for kind === "command"
};

/** Returns the active TabResult for a tab, or null if none. */
export function activeResult(tab: SqlTab): TabResult | null {
  if (tab.activeResultId === null) return null;
  return tab.results.find((r) => r.id === tab.activeResultId) ?? null;
}

/** Truncate sql to first ~80 chars, single line. */
function makeSqlPreview(sql: string): string {
  const single = sql.replace(/\s+/g, " ").trim();
  return single.length > 80 ? single.slice(0, 80) : single;
}

// ── Compile detection ─────────────────────────────────────────────────────────

export const COMPILE_REGEX =
  /^\s*CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE(\s+BODY)?|TYPE(\s+BODY)?)\s+("?\w+"?\.)?"?(\w+)"?/i;

function extractCompilable(sql: string): { objectType: string; objectName: string } | null {
  const m = COMPILE_REGEX.exec(sql);
  if (!m) return null;
  const rawType = m[3].toUpperCase();
  const body = (m[4] || m[5]) ? " BODY" : "";
  const objectType = rawType + body;
  const objectName = (m[7] ?? "").toUpperCase();
  if (!objectName) return null;
  return { objectType, objectName };
}

/**
 * Decide whether to fire a parallel EXPLAIN PLAN for this SQL given the
 * connection's policy. NEVER explains COMMIT / ROLLBACK / SET / ALTER SESSION
 * (sidecar would refuse anyway). NEVER explains PL/SQL anonymous blocks
 * (EXPLAIN PLAN doesn't support them).
 */
export function shouldAutoExplain(sql: string, mode: "manual" | "always" | "when_dml"): boolean {
  if (mode === "manual") return false;
  const trimmed = sql.trim().replace(/^[\s\n]*--.*$/gm, "").trim();
  // PL/SQL block — anything starting with BEGIN or DECLARE — skip.
  if (/^(begin|declare)\b/i.test(trimmed)) return false;
  // Match the leading keyword, ignoring leading WITH (CTE) clauses.
  const leadingKwMatch = trimmed.match(/^([a-zA-Z_]+)/);
  if (!leadingKwMatch) return false;
  const kw = leadingKwMatch[1].toUpperCase();
  if (mode === "always") {
    return ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(kw);
  }
  // when_dml
  return ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(kw);
}

let _tabs = $state<SqlTab[]>([]);
let _activeId = $state<string | null>(null);
let _drawerOpen = $state(false);
let _queryCounter = $state(0);
let _connectionId: string | null = null;
let _connectionName: string | null = null;
let _connectionUsername: string | null = null;
let _connectionHost: string | null = null;
// PROD-002 (audit 2026-04-30): track the connection's safety env so the audit
// uploader can switch to metadata-only mode automatically for prod connections.
let _connectionEnv: "local" | "dev" | "staging" | "prod" | null = null;
// L3.2 (Onda 3): per-connection auto-EXPLAIN policy. Drives runActive's
// parallel EXPLAIN PLAN fetch after a successful SELECT/DML.
let _autoExplainMode: "manual" | "always" | "when_dml" = "always";
type PendingConfirm = {
  sql: string;
  ops: DestructiveOp[];
  resolve: (confirmed: boolean) => void;
};
let _pendingConfirm = $state<PendingConfirm | null>(null);

type PendingUnsafeDml = {
  sql: string;
  message: string;
  resolve: (confirmed: boolean) => void;
};
let _pendingUnsafeDml = $state<PendingUnsafeDml | null>(null);

// Authoritative TX state — sourced from sidecar `connection.txState` RPC, which
// reads `DBMS_TRANSACTION.LOCAL_TRANSACTION_ID`. Replaces the previous boolean
// heuristic `result.columns.length === 0 && result.rowCount > 0` that mis-classified
// UPDATE...RETURNING / MERGE OUTPUT / PL/SQL with internal DML / DDL implicit-commit.
//
// Optimistic update: when the user runs a modifying statement, we increment
// pendingStatements locally so the UI feels instant. Right after the exec
// resolves we reconcile via `reconcileTxState()` which fetches the authoritative
// state from the sidecar (cached in-memory there, only round-trips Oracle once
// per modify when needed). If Oracle disagrees (e.g. DDL implicit-commit, PL/SQL
// internal COMMIT, killed session), the reconcile call corrects the UI state.
let _txState = $state<TxStateView>({
  hasOpenTx: false,
  pendingStatements: 0,
  lastTxId: null,
  lastModifyingAt: null,
  lastModifyingType: null,
});
let _editorExpanded = $state(false);

// Lightweight client-side classifier — only used for optimistic updates and
// to decide whether to bother calling reconcileTxState() after exec. Sidecar's
// classifySql() is the authoritative version; this is a deliberately narrower
// match (just leading keyword) since we only need "is this likely modifying?".
function classifySqlOptimistic(sql: string): "modifying" | "tcl_close" | "other" {
  const trimmed = sql
    .replace(/^\s*--[^\n]*\n+/g, "")
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, "")
    .trim()
    .toUpperCase();
  if (/^(COMMIT|ROLLBACK)\b/.test(trimmed)) return "tcl_close";
  if (
    /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE|SAVEPOINT|SET\s+TRANSACTION|BEGIN|DECLARE|CALL)\b/.test(
      trimmed,
    )
  ) {
    return "modifying";
  }
  return "other";
}

function optimisticTxBump(): void {
  _txState = {
    ..._txState,
    pendingStatements: _txState.pendingStatements + 1,
    lastModifyingAt: Date.now(),
    hasOpenTx: true,
  };
}

function clearTxStateLocal(): void {
  _txState = {
    hasOpenTx: false,
    pendingStatements: 0,
    lastTxId: null,
    lastModifyingAt: null,
    lastModifyingType: null,
  };
}

async function reconcileTxState(): Promise<void> {
  const res = await connectionTxState();
  if (res.ok) {
    _txState = res.data;
  }
}

// ── Drawer height ────────────────────────────────────────────────────────────

function loadDrawerHeight(): number {
  if (typeof window === "undefined") return 360;
  try {
    const raw = localStorage.getItem("veesker.sql.drawerHeight");
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 120 && n <= 2000) return n;
    }
  } catch {
    // Safari private mode or restricted environment
  }
  return Math.round(window.innerHeight * 0.4);
}

function loadEditorRatio(): number {
  if (typeof window === "undefined") return 0.35;
  try {
    const raw = localStorage.getItem("veesker.sql.editorRatio");
    if (raw !== null) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= 0.15 && n <= 0.85) return n;
    }
  } catch {
    // Safari private mode or restricted environment
  }
  return 0.35;
}

function loadLogCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem("veesker.sql.logCollapsed");
    if (raw !== null) return raw === "true";
  } catch { /* Safari private mode */ }
  return false;
}

function loadHistoryPanelOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem("veesker.sql.historyPanelOpen");
    if (raw !== null) return raw === "true";
  } catch { /* Safari private mode */ }
  return true;
}

let _drawerHeight = $state<number>(loadDrawerHeight());
let _editorRatio = $state<number>(loadEditorRatio());
let _logCollapsed = $state<boolean>(loadLogCollapsed());
let _historyPanelOpen = $state<boolean>(loadHistoryPanelOpen());

// ── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function nextQueryTitle(): string {
  _queryCounter += 1;
  return `Query ${_queryCounter}`;
}

function makeTab(title: string, sql: string): SqlTab {
  return {
    id: newId(),
    kind: "sql",
    title,
    sql,
    results: [],
    activeResultId: null,
    running: false,
    splitterError: null,
    runningRequestId: null,
    filePath: null,
    isDirty: false,
    savedContent: null,
    plsqlMeta: null,
    packageSpec: undefined,
    packageActiveTab: undefined,
    specMeta: undefined,
    connectionId: null,
  };
}

function nextCommandTitle(): string {
  const used = new Set(_tabs.filter((t) => t.kind === "command").map((t) => t.title));
  let n = 1;
  while (used.has(`Command ${n}`)) n++;
  return `Command ${n}`;
}

function makeCommandTab(connectionId: string): SqlTab {
  return {
    id: newId(),
    kind: "command",
    title: nextCommandTitle(),
    sql: "",
    results: [],
    activeResultId: null,
    running: false,
    splitterError: null,
    runningRequestId: null,
    filePath: null,
    isDirty: false,
    savedContent: null,
    plsqlMeta: null,
    packageSpec: undefined,
    packageActiveTab: undefined,
    specMeta: undefined,
    connectionId,
  };
}

function findTab(id: string): SqlTab | null {
  return _tabs.find((t) => t.id === id) ?? null;
}

// Matches anonymous PL/SQL blocks (BEGIN...END; / DECLARE...END;).
// These blocks must retain their trailing semicolon — the sidecar handles
// driver-mode-specific stripping (Thick needs it; Thin strips to avoid a
// driver bug where passing options causes incorrect auto-stripping).
const _PLSQL_ANON_RE = /^(?:[ \t]*--[^\n]*\n)*[ \t]*(?:BEGIN|DECLARE)\b/i;

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim();
  if (_PLSQL_ANON_RE.test(trimmed)) return trimmed;
  if (trimmed.endsWith(";")) return trimmed.slice(0, -1).trim();
  return trimmed;
}

/**
 * Choose which result id to set as activeResultId after a run.
 * Prefer the last ok result that has columns (i.e. a SELECT with rows).
 * Fallback to the last result's id.
 */
function chooseActiveResultId(results: TabResult[]): string | null {
  if (results.length === 0) return null;
  // Find last ok result with columns (SELECT-like)
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (r.status === "ok" && r.result !== null && r.result.columns.length > 0) {
      return r.id;
    }
  }
  // Fallback to last result
  return results[results.length - 1].id;
}

/** Fire-and-forget: persist a completed statement to query history. */
function pushHistory(sql: string, r: TabResult): void {
  if (_connectionId === null) return;
  if (r.status === "cancelled") return;
  const success = r.status === "ok";
  const rowCount = r.status === "ok" && r.result !== null ? r.result.rowCount : null;
  const errorCode = r.status === "error" && r.error !== null ? r.error.code : null;
  const errorMessage = r.status === "error" && r.error !== null ? r.error.message : null;
  void historySave({
    connectionId: _connectionId,
    sql,
    success,
    rowCount,
    elapsedMs: r.elapsedMs,
    errorCode,
    errorMessage,
    username: _connectionUsername,
    host: _connectionHost,
  }).catch((e) => console.warn("history save failed:", e));
  void CloudAuditService.push(
    {
      connectionId: _connectionId || null,
      connectionName: _connectionName || null,
      host: _connectionHost || null,
      sql,
      success,
      rowCount,
      elapsedMs: r.elapsedMs,
      errorCode,
      errorMessage,
    },
    // PROD-002: forwards env so the service can switch to metadata-only mode
    // automatically for prod-tagged connections.
    _connectionEnv,
  );
}

function askConfirm(sql: string): true | Promise<boolean> {
  const ops = detectDestructive(sql);
  if (ops.length === 0) return true;
  if (_pendingConfirm !== null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    _pendingConfirm = { sql, ops, resolve };
  });
}

const UNSAFE_DML_WARNING_CODE = -32031;

function isUnsafeDmlError(err: { code?: number } | null | undefined): boolean {
  return !!err && err.code === UNSAFE_DML_WARNING_CODE;
}

/** Returns true if user clicked Run anyway, false if Cancel. */
function askUnsafeDml(sql: string, message: string): Promise<boolean> {
  if (_pendingUnsafeDml !== null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    _pendingUnsafeDml = { sql, message, resolve };
  });
}

export const sqlEditor = {
  get tabs() { return _tabs; },
  get activeId() { return _activeId; },
  get drawerOpen() { return _drawerOpen; },
  get active(): SqlTab | null {
    return _activeId === null ? null : findTab(_activeId);
  },
  get connectionId() { return _connectionId; },
  setConnectionContext(
    id: string | null,
    name: string | null,
    username: string | null,
    host: string | null,
    env: "local" | "dev" | "staging" | "prod" | null = null,
    autoExplainMode: "manual" | "always" | "when_dml" = "manual",
  ): void {
    _connectionId = id;
    _connectionName = name;
    _connectionUsername = username;
    _connectionHost = host;
    _connectionEnv = env;
    _autoExplainMode = autoExplainMode;
  },
  get pendingConfirm(): PendingConfirm | null { return _pendingConfirm; },
  confirmRun(confirmed: boolean): void {
    if (_pendingConfirm) {
      _pendingConfirm.resolve(confirmed);
      _pendingConfirm = null;
    }
  },

  get pendingUnsafeDml(): PendingUnsafeDml | null { return _pendingUnsafeDml; },
  resolveUnsafeDml(confirmed: boolean): void {
    if (_pendingUnsafeDml) {
      _pendingUnsafeDml.resolve(confirmed);
      _pendingUnsafeDml = null;
    }
  },
  // Backwards-compat boolean — true iff there's any uncommitted work.
  get pendingTx() { return _txState.hasOpenTx; },
  // Authoritative TxState shape for callers that need count / type / age.
  get txState(): TxStateView { return _txState; },
  clearPendingTx(): void { clearTxStateLocal(); },
  /** Force a re-fetch from the sidecar — used by the close-window modal flow. */
  async refreshTxState(): Promise<void> { await reconcileTxState(); },

  // ── Editor expanded (fullscreen mode) ─────────────────────────────────────
  get editorExpanded() { return _editorExpanded; },
  toggleEditorExpanded(): void { _editorExpanded = !_editorExpanded; },

  // ── Drawer height ──────────────────────────────────────────────────────────
  get drawerHeight() { return _drawerHeight; },
  setDrawerHeight(px: number): void {
    const clamped = Math.max(120, Math.min(2000, px));
    _drawerHeight = clamped;
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("veesker.sql.drawerHeight", String(Math.round(clamped)));
      }
    } catch {
      // Safari private mode or restricted environment
    }
  },

  // ── Editor ratio ───────────────────────────────────────────────────────────
  get editorRatio() { return _editorRatio; },
  setEditorRatio(r: number): void {
    const clamped = Math.max(0.15, Math.min(0.85, r));
    _editorRatio = clamped;
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("veesker.sql.editorRatio", clamped.toFixed(4));
      }
    } catch {
      // Safari private mode or restricted environment
    }
  },

  // ── Log collapsed ──────────────────────────────────────────────────────────
  get logCollapsed() { return _logCollapsed; },
  toggleLog(): void {
    _logCollapsed = !_logCollapsed;
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("veesker.sql.logCollapsed", String(_logCollapsed));
      }
    } catch { /* Safari private mode */ }
  },

  // ── History panel ──────────────────────────────────────────────────────────
  get historyPanelOpen() { return _historyPanelOpen; },
  toggleHistoryPanel(): void {
    _historyPanelOpen = !_historyPanelOpen;
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("veesker.sql.historyPanelOpen", String(_historyPanelOpen));
      }
    } catch { /* Safari private mode */ }
  },

  loadHistoryEntry(entry: HistoryEntry): void {
    const tab = makeTab(nextQueryTitle(), entry.sql);
    _tabs.push(tab);
    _activeId = tab.id;
    _drawerOpen = true;
  },

  setActiveResult(tabId: string, resultId: string): void {
    const tab = findTab(tabId);
    if (tab === null) return;
    const exists = tab.results.some((r) => r.id === resultId);
    if (!exists) return;
    tab.activeResultId = resultId;
  },

  openBlank(): void {
    const tab = makeTab(nextQueryTitle(), "");
    _tabs.push(tab);
    _activeId = tab.id;
    _drawerOpen = true;
  },

  openCommandTab(connectionId: string): string {
    const tab = makeCommandTab(connectionId);
    _tabs.push(tab);
    _activeId = tab.id;
    _drawerOpen = true;
    return tab.id;
  },

  async openPreview(owner: string, name: string, pkCols?: string[]): Promise<void> {
    const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const orderBy = pkCols && pkCols.length > 0
      ? ` ORDER BY ${pkCols.map(qi).join(", ")}`
      : "";
    const sql = `SELECT * FROM ${qi(owner)}.${qi(name)}${orderBy} FETCH FIRST 200 ROWS ONLY`;
    const tab = makeTab(`${owner}.${name}`, sql);
    _tabs.push(tab);
    _activeId = tab.id;
    _drawerOpen = true;
    await this.runActive();
  },

  closeTab(id: string): void {
    const idx = _tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    _tabs.splice(idx, 1);
    if (_activeId === id) {
      if (_tabs.length === 0) {
        _activeId = null;
      } else {
        _activeId = _tabs[Math.max(0, idx - 1)].id;
      }
    }
  },

  setActive(id: string): void {
    if (findTab(id) !== null) _activeId = id;
  },

  updateSql(id: string, sql: string): void {
    const tab = findTab(id);
    if (tab !== null) {
      tab.sql = sql;
      tab.isDirty = tab.savedContent !== null && tab.sql !== tab.savedContent;
    }
  },

  setPackageActiveTab(tabId: string, tab: "spec" | "body"): void {
    const t = findTab(tabId);
    if (t !== null) {
      t.packageActiveTab = tab;
    }
  },

  updatePackageSpec(tabId: string, sql: string): void {
    const t = findTab(tabId);
    if (t !== null) {
      t.packageSpec = sql;
    }
  },

  setPackageSpec(tabId: string, spec: string, specMeta: PlsqlMeta): void {
    const t = findTab(tabId);
    if (t !== null) {
      t.packageSpec = spec;
      t.specMeta = specMeta;
      t.packageActiveTab = "spec";
    }
  },

  toggleDrawer(): void {
    _drawerOpen = !_drawerOpen;
  },

  /**
   * Sprint D Onda 1 (Bundle 8): shared single-statement execution path used
   * by SqlEditor (Run button / runActive / runSelection / runStatementAtCursor)
   * and Command Window (Bundle 9 executor).
   *
   * Safety pipeline layers applied:
   *   1. askConfirm() for TRUNCATE / DROP / destructive DDL  (Sprint A)
   *      — bypassable via opts.bypassConfirm
   *   2. askUnsafeDml() for UPDATE/DELETE without WHERE       (Sprint B)
   *      — server emits code -32031; we re-prompt and replay with
   *        acknowledgeUnsafe=true. Bypassable via opts.bypassUnsafeDml.
   *   3. ProductionDetector / PSDPM hard-lock                 (Sprint C O.1)
   *      — enforced server-side; surfaces here as an error Result that
   *        we forward without prompting.
   *   4. Origin attribution                                   (Sprint B)
   *      — opts.origin is forwarded into queryExecute so the Activity
   *        Ledger differentiates user_typed (Command Mode) from
   *        user_clicked (toolbar) and ai_approved (Sheep AI).
   *   5. DBMS_OUTPUT capture                                  (Sprint C O.3 L3.3)
   *      — drained by the sidecar after execute; returned in
   *        SharedExecResult.dbmsOutput.
   *   6. Audit (HMAC chain in CL / encrypted JSONL)
   *      — written server-side on every execute; opts.audit=false is a
   *        reserved flag for future internal/system calls and is currently
   *        a no-op (server still audits). Default true.
   *
   * Cancel surface: callers are responsible for tracking the requestId if
   * they want to cancel; this function does NOT register the requestId on
   * any tab. SqlEditor's runActive() sets tab.runningRequestId itself before
   * calling. Command Mode will hold its own AbortController and surface a
   * Ctrl+C handler that calls queryCancel() with the same requestId.
   *
   * Does NOT touch tab.results / tab.busy / tab.error — the caller manages
   * its own UI state.
   */
  async runStatementShared(
    sql: string,
    opts: {
      origin: SqlOrigin;
      audit?: boolean;
      autoExplain?: boolean;
      bypassConfirm?: boolean;
      bypassUnsafeDml?: boolean;
      requestId?: string;
    },
  ): Promise<Result<SharedExecResult>> {
    const cleaned = stripTrailingSemicolon(sql);
    if (cleaned === "") {
      return { ok: false, error: { code: -32099, message: "empty statement" } };
    }
    if (!opts.bypassConfirm) {
      const c = askConfirm(cleaned);
      const okConfirm = c === true || (await c);
      if (!okConfirm) {
        return { ok: false, error: { code: -32098, message: "Operation cancelled by user." } };
      }
    }
    const requestId = opts.requestId ?? crypto.randomUUID();
    const t0 = performance.now();
    let res = await queryExecute(cleaned, requestId, false, false, opts.origin);
    if (!res.ok && isUnsafeDmlError(res.error)) {
      if (opts.bypassUnsafeDml) {
        res = await queryExecute(cleaned, requestId, false, true, opts.origin);
      } else {
        const ack = await askUnsafeDml(cleaned, res.error?.message ?? "");
        if (!ack) {
          return { ok: false, error: { code: -32098, message: "Operation cancelled by user." } };
        }
        res = await queryExecute(cleaned, requestId, false, true, opts.origin);
      }
    }
    if (!res.ok) {
      return { ok: false, error: res.error ?? { code: -32000, message: "Unknown error" } };
    }
    const elapsedMs = res.data.elapsedMs > 0 ? res.data.elapsedMs : Math.round(performance.now() - t0);
    return {
      ok: true,
      data: {
        rows: res.data.rows ?? [],
        columns: res.data.columns ?? [],
        rowCount: res.data.rowCount,
        elapsedMs,
        dbmsOutput: res.data.dbmsOutput ?? [],
        warnings: [],
      },
    };
  },

  /** Run the active tab's full SQL as a single statement (cursor-based or whole-buffer). */
  async runActive(): Promise<void> {
    const tab = this.active;
    if (tab === null) return;
    const rawSql = tab.packageActiveTab === "spec" ? (tab.packageSpec ?? tab.sql) : tab.sql;
    const sql = stripTrailingSemicolon(rawSql);
    if (sql === "") return;
    { const _c = askConfirm(sql); if (_c !== true && !(await _c)) return; }
    const requestId = crypto.randomUUID();
    const resultId = newId();
    tab.running = true;
    tab.runningRequestId = requestId;
    tab.splitterError = null;
    tab.results = [];
    tab.activeResultId = null;
    try {
      let res = await queryExecute(sql, requestId);
      if (!res.ok && isUnsafeDmlError(res.error)) {
        const ack = await askUnsafeDml(sql, res.error?.message ?? "");
        if (!ack) {
          tab.results = [];
          tab.activeResultId = null;
          return;
        }
        res = await queryExecute(sql, requestId, false, true);
      }
      const tabResult: TabResult = {
        id: resultId,
        statementIndex: 0,
        sqlPreview: makeSqlPreview(sql),
        sqlOriginal: sql,
        status: res.ok ? "ok" : "error",
        result: res.ok ? res.data : null,
        error: res.ok ? null : res.error,
        elapsedMs: res.ok ? res.data.elapsedMs : 0,
        dbmsOutput: res.ok ? (res.data.dbmsOutput ?? null) : null,
        compileErrors: null,
        explainNodes: null,
        fetchedAll: false,
      };
      tab.results = [tabResult];
      tab.activeResultId = resultId;
      pushHistory(sql, tabResult);
      // L3.2 (Onda 3): fire parallel EXPLAIN if connection policy allows.
      // EXPLAIN runs on a separate Oracle session, so it does not stall
      // the user's reading of the result grid. On error, swallow silently
      // — the Plan tab will show idle/error state.
      if (tabResult.status === "ok" && shouldAutoExplain(sql, _autoExplainMode)) {
        const tabIdRef = tab.id;
        const resultIdRef = resultId;
        explainPlanGet(sql).then((er) => {
          const t = _tabs.find((x) => x.id === tabIdRef);
          if (!t) return;
          const r = t.results.find((x) => x.id === resultIdRef);
          if (!r) return;
          if (er.ok) {
            r.explainNodes = er.data.nodes;
            r.explainError = undefined;
          } else {
            r.explainError = er.error?.message ?? "Explain plan failed";
          }
          _tabs = [..._tabs];
        });
      }
      if (tabResult.status === "ok") {
        const kind = classifySqlOptimistic(sql);
        if (kind === "modifying") {
          optimisticTxBump();
          void reconcileTxState();
        } else if (kind === "tcl_close") {
          void reconcileTxState();
        }
      }
      if (tabResult.status === "ok") {
        const compilable = extractCompilable(sql);
        if (compilable) {
          const tabId = tab.id;
          compileErrorsGet(compilable.objectType, compilable.objectName).then((ceRes) => {
            const t = _tabs.find((x) => x.id === tabId);
            if (!t) return;
            const r = t.results.find((x) => x.id === resultId);
            if (r) {
              r.compileErrors = ceRes.ok ? ceRes.data : [];
              _tabs = [..._tabs];
            }
            if (ceRes.ok && ceRes.data.length === 0 && t.plsqlMeta) {
              const meta = t.packageActiveTab === "spec" ? t.specMeta : t.plsqlMeta;
              const captureSql = t.packageActiveTab === "spec" ? (t.packageSpec ?? t.sql) : t.sql;
              if (meta) {
                const { connectionId, owner, objectType, objectName } = meta;
                void objectVersionCapture(connectionId, owner, objectType, objectName, captureSql, "compile");
              }
            }
          });
        }
      }
    } finally {
      tab.running = false;
      tab.runningRequestId = null;
    }
  },

  /** Run all statements in the active tab using the SQL splitter. */
  async runActiveAll(): Promise<void> {
    const tab = this.active;
    if (tab === null) return;
    const sql = tab.packageActiveTab === "spec" ? (tab.packageSpec ?? tab.sql) : tab.sql;
    if (sql.trim() === "") return;

    // Pre-flight: check splitter on the frontend to show the error banner early.
    // If there are splitter errors, warn but still send to sidecar — valid completed
    // statements (those terminated before the error) will be executed normally.
    const { statements: preflight, errors } = splitSql(sql);
    if (errors.length > 0) {
      tab.splitterError = errors.map((e) => `line ${e.line}: ${e.message}`).join("; ");
      if (preflight.length === 0) {
        tab.results = [];
        tab.activeResultId = null;
        return;
      }
    }

    { const _c = askConfirm(sql); if (_c !== true && !(await _c)) return; }
    const requestId = crypto.randomUUID();
    tab.running = true;
    tab.runningRequestId = requestId;
    tab.splitterError = null;
    tab.results = [];
    tab.activeResultId = null;

    try {
      let res = await queryExecuteMulti(sql, requestId);
      if (!res.ok && isUnsafeDmlError(res.error)) {
        const ack = await askUnsafeDml(sql, res.error?.message ?? "");
        if (!ack) {
          tab.results = [];
          tab.activeResultId = null;
          return;
        }
        res = await queryExecuteMulti(sql, requestId, true);
      }
      if (!res.ok) {
        // Server-side error (e.g. splitter error from sidecar, or session lost)
        const errMsg = res.error?.message ?? "Unknown error";
        // Check if it's a splitter error from the sidecar
        if (typeof res.error?.code === "number" && res.error.code === -32014) {
          tab.splitterError = errMsg.replace(/^Splitter error:\s*/i, "");
        } else {
          // Generic error: create a single error result
          const errResult: TabResult = {
            id: newId(),
            statementIndex: 0,
            sqlPreview: makeSqlPreview(sql),
            sqlOriginal: sql,
            status: "error",
            result: null,
            error: res.error ?? { code: -32000, message: errMsg },
            elapsedMs: 0,
            dbmsOutput: null,
            compileErrors: null,
            explainNodes: null,
            fetchedAll: false,
          };
          tab.results = [errResult];
          tab.activeResultId = errResult.id;
        }
        return;
      }

      // L3.2 (Onda 3): auto-EXPLAIN is intentionally NOT triggered for the
      // multi-statement script path. Running EXPLAIN for every script statement
      // can easily fire N concurrent EXPLAIN calls. Manual EXPLAIN via the
      // existing runExplain() entrypoint remains available.
      const tabResults: TabResult[] = res.data.results.map((sr) => {
        const id = newId();
        const sqlPreview = makeSqlPreview(sr.sql);
        if (sr.status === "ok") {
          return {
            id,
            statementIndex: sr.statementIndex,
            sqlPreview,
            sqlOriginal: sr.sql,
            status: "ok" as const,
            result: { columns: sr.columns, rows: sr.rows, rowCount: sr.rowCount, elapsedMs: sr.elapsedMs },
            error: null,
            elapsedMs: sr.elapsedMs,
            dbmsOutput: sr.output ?? null,
            compileErrors: null,
            explainNodes: null,
            fetchedAll: false,
          };
        } else if (sr.status === "error") {
          return {
            id,
            statementIndex: sr.statementIndex,
            sqlPreview,
            sqlOriginal: sr.sql,
            status: "error" as const,
            result: null,
            error: sr.error,
            elapsedMs: sr.elapsedMs,
            dbmsOutput: sr.output ?? null,
            compileErrors: null,
            explainNodes: null,
            fetchedAll: false,
          };
        } else {
          // cancelled
          return {
            id,
            statementIndex: sr.statementIndex,
            sqlPreview,
            sqlOriginal: sr.sql,
            status: "cancelled" as const,
            result: null,
            error: null,
            elapsedMs: sr.elapsedMs,
            dbmsOutput: null,
            compileErrors: null,
            explainNodes: null,
            fetchedAll: false,
          };
        }
      });

      tab.results = tabResults;
      tab.activeResultId = chooseActiveResultId(tabResults);
      for (let i = 0; i < tabResults.length; i++) {
        pushHistory(res.data.results[i].sql, tabResults[i]);
      }
      // Sidecar already synced TxState per statement during multi-exec; just
      // reconcile if any of the executed SQL was modifying or TCL.
      if (
        res.data.results.some((sr) => {
          const k = classifySqlOptimistic(sr.sql);
          return k === "modifying" || k === "tcl_close";
        })
      ) {
        void reconcileTxState();
      }

      // Post-execution compile check for CREATE statements
      const tabId = tab.id;
      for (const sr of res.data.results) {
        if (sr.status !== "ok") continue;
        const compilable = extractCompilable(sr.sql);
        if (!compilable) continue;
        const resultId = tabResults[sr.statementIndex]?.id;
        if (!resultId) continue;
        compileErrorsGet(compilable.objectType, compilable.objectName).then((ceRes) => {
          const t = _tabs.find((x) => x.id === tabId);
          if (!t) return;
          const r = t.results.find((x) => x.id === resultId);
          if (r) {
            r.compileErrors = ceRes.ok ? ceRes.data : [];
            _tabs = [..._tabs];
          }
          if (ceRes.ok && ceRes.data.length === 0 && t.plsqlMeta) {
            const meta = t.packageActiveTab === "spec" ? t.specMeta : t.plsqlMeta;
            const captureSql = t.packageActiveTab === "spec" ? (t.packageSpec ?? t.sql) : t.sql;
            if (meta) {
              const { connectionId, owner, objectType, objectName } = meta;
              void objectVersionCapture(connectionId, owner, objectType, objectName, captureSql, "compile");
            }
          }
        });
      }
    } finally {
      tab.running = false;
      tab.runningRequestId = null;
    }
  },

  /** Run a selection of text as a single statement. */
  async runSelection(selection: string): Promise<void> {
    const tab = this.active;
    if (tab === null) return;
    const sql = stripTrailingSemicolon(selection);
    if (sql === "") return;
    { const _c = askConfirm(sql); if (_c !== true && !(await _c)) return; }
    const requestId = crypto.randomUUID();
    const resultId = newId();
    tab.running = true;
    tab.runningRequestId = requestId;
    tab.splitterError = null;
    tab.results = [];
    tab.activeResultId = null;
    try {
      let res = await queryExecute(sql, requestId);
      if (!res.ok && isUnsafeDmlError(res.error)) {
        const ack = await askUnsafeDml(sql, res.error?.message ?? "");
        if (!ack) {
          tab.results = [];
          tab.activeResultId = null;
          return;
        }
        res = await queryExecute(sql, requestId, false, true);
      }
      const tabResult: TabResult = {
        id: resultId,
        statementIndex: 0,
        sqlPreview: makeSqlPreview(sql),
        sqlOriginal: sql,
        status: res.ok ? "ok" : "error",
        result: res.ok ? res.data : null,
        error: res.ok ? null : res.error,
        elapsedMs: res.ok ? res.data.elapsedMs : 0,
        dbmsOutput: null,
        compileErrors: null,
        explainNodes: null,
        fetchedAll: false,
      };
      tab.results = [tabResult];
      tab.activeResultId = resultId;
      pushHistory(sql, tabResult);
      if (tabResult.status === "ok") {
        const kind = classifySqlOptimistic(sql);
        if (kind === "modifying") {
          optimisticTxBump();
          void reconcileTxState();
        } else if (kind === "tcl_close") {
          void reconcileTxState();
        }
      }
    } finally {
      tab.running = false;
      tab.runningRequestId = null;
    }
  },

  /**
   * Run the statement that contains the cursor position.
   * Splits the document, finds which statement the cursor is inside,
   * and runs just that one. Falls back to running the whole tab if no match.
   */
  async runStatementAtCursor(fullText: string, cursorPos: number): Promise<void> {
    const tab = this.active;
    if (tab === null) return;

    const { statements, errors } = splitSql(fullText);
    if (statements.length === 0) {
      // Nothing valid to run — fall back to running whole buffer as single statement
      return this.runActive();
    }
    if (errors.length > 0) {
      tab.splitterError = errors.map((e) => `line ${e.line}: ${e.message}`).join("; ");
    }

    // Recover each statement's start/end character position in the original text
    // by scanning forward with indexOf from the last match end.
    let searchFrom = 0;
    let matchedSql: string | null = null;

    for (const stmt of statements) {
      const idx = fullText.indexOf(stmt, searchFrom);
      if (idx === -1) continue;
      const stmtEnd = idx + stmt.length;
      if (cursorPos >= idx && cursorPos <= stmtEnd) {
        matchedSql = stmt;
        break;
      }
      searchFrom = stmtEnd;
    }

    if (matchedSql === null) {
      // Cursor is between statements — find the nearest one before cursor
      searchFrom = 0;
      let lastBeforeCursor: string | null = null;
      for (const stmt of statements) {
        const idx = fullText.indexOf(stmt, searchFrom);
        if (idx === -1) continue;
        if (idx <= cursorPos) {
          lastBeforeCursor = stmt;
        }
        searchFrom = idx + stmt.length;
      }
      matchedSql = lastBeforeCursor ?? statements[0];
    }

    const sqlToRun = stripTrailingSemicolon(matchedSql);
    { const _c = askConfirm(sqlToRun); if (_c !== true && !(await _c)) return; }
    const requestId = crypto.randomUUID();
    const resultId = newId();
    tab.running = true;
    tab.runningRequestId = requestId;
    tab.splitterError = null;
    tab.results = [];
    tab.activeResultId = null;
    try {
      let res = await queryExecute(sqlToRun, requestId);
      if (!res.ok && isUnsafeDmlError(res.error)) {
        const ack = await askUnsafeDml(sqlToRun, res.error?.message ?? "");
        if (!ack) {
          tab.results = [];
          tab.activeResultId = null;
          return;
        }
        res = await queryExecute(sqlToRun, requestId, false, true);
      }
      const tabResult: TabResult = {
        id: resultId,
        statementIndex: 0,
        sqlPreview: makeSqlPreview(sqlToRun),
        sqlOriginal: sqlToRun,
        status: res.ok ? "ok" : "error",
        result: res.ok ? res.data : null,
        error: res.ok ? null : res.error,
        elapsedMs: res.ok ? res.data.elapsedMs : 0,
        dbmsOutput: null,
        compileErrors: null,
        explainNodes: null,
        fetchedAll: false,
      };
      tab.results = [tabResult];
      tab.activeResultId = resultId;
      pushHistory(sqlToRun, tabResult);
      if (tabResult.status === "ok") {
        const kind = classifySqlOptimistic(sqlToRun);
        if (kind === "modifying") {
          optimisticTxBump();
          void reconcileTxState();
        } else if (kind === "tcl_close") {
          void reconcileTxState();
        }
      }
      if (tabResult.status === "ok") {
        const compilable = extractCompilable(sqlToRun);
        if (compilable) {
          const tabId = tab.id;
          compileErrorsGet(compilable.objectType, compilable.objectName).then((ceRes) => {
            const t = _tabs.find((x) => x.id === tabId);
            if (!t) return;
            const r = t.results.find((x) => x.id === resultId);
            if (r) {
              r.compileErrors = ceRes.ok ? ceRes.data : [];
              _tabs = [..._tabs];
            }
            if (ceRes.ok && ceRes.data.length === 0 && t.plsqlMeta) {
              const meta = t.packageActiveTab === "spec" ? t.specMeta : t.plsqlMeta;
              const captureSql = t.packageActiveTab === "spec" ? (t.packageSpec ?? t.sql) : t.sql;
              if (meta) {
                const { connectionId, owner, objectType, objectName } = meta;
                void objectVersionCapture(connectionId, owner, objectType, objectName, captureSql, "compile");
              }
            }
          });
        }
      }
    } finally {
      tab.running = false;
      tab.runningRequestId = null;
    }
  },

  async saveActive(): Promise<void> {
    const tab = this.active;
    if (tab === null) return;
    if (tab.filePath === null) {
      await this.saveAsActive();
      return;
    }
    if (!tab.isDirty) return;
    const tabId = tab.id;
    const tabFilePath = tab.filePath;
    const sqlToSave = tab.sql;
    try {
      await saveExisting(tabFilePath, sqlToSave);
      const liveTab = findTab(tabId);
      if (liveTab === null) return;
      liveTab.savedContent = sqlToSave;
      liveTab.isDirty = false;
    } catch (e) {
      toasts.error(`Save failed: ${String(e)}`);
    }
  },

  async saveAsActive(): Promise<void> {
    const tab = this.active;
    if (tab === null) return;
    const defaultName = tab.filePath
      ? tab.filePath.split(/[\\/]/).pop()!.replace(/\.sql$/i, "")
      : tab.title;
    const sqlToSave = tab.sql;
    const tabId = tab.id;
    try {
      const path = await saveAs(sqlToSave, defaultName);
      if (path === null) return;
      const liveTab = findTab(tabId);
      if (liveTab === null) return;
      liveTab.filePath = path;
      const base = path.split(/[\\/]/).pop() ?? path;
      liveTab.title = base.replace(/\.sql$/i, "");
      liveTab.savedContent = sqlToSave;
      liveTab.isDirty = liveTab.sql !== sqlToSave;
    } catch (e) {
      toasts.error(`Save failed: ${String(e)}`);
    }
  },

  async openFromFile(): Promise<void> {
    try {
      const result = await openFile();
      if (result === null) return;
      const base = result.path.split(/[\\/]/).pop() ?? result.path;
      const title = base.replace(/\.sql$/i, "");
      const tab = makeTab(title, result.content);
      tab.filePath = result.path;
      tab.savedContent = result.content;
      tab.isDirty = false;
      _tabs.push(tab);
      _activeId = tab.id;
      _drawerOpen = true;
    } catch (e) {
      toasts.error(`Open failed: ${String(e)}`);
    }
  },

  async cancelActive(): Promise<void> {
    const tab = this.active;
    if (tab === null || tab.runningRequestId === null) return;
    await queryCancel(tab.runningRequestId);
    // The original run promise will reject with code -2;
    // its finally block will clear running / runningRequestId.
  },

  /** Re-run the active result's SQL with no row limit, replacing it in place. */
  async fetchAllForActiveResult(): Promise<void> {
    const tab = this.active;
    if (tab === null) return;
    const ar = activeResult(tab);
    if (ar === null || ar.sqlOriginal === null) return;
    const sql = stripTrailingSemicolon(ar.sqlOriginal);
    if (sql === "") return;
    const requestId = crypto.randomUUID();
    tab.running = true;
    tab.runningRequestId = requestId;
    try {
      const res = await queryExecute(sql, requestId, true);
      const idx = tab.results.findIndex((r) => r.id === ar.id);
      if (idx === -1) return;
      const replacement: TabResult = {
        ...ar,
        status: res.ok ? "ok" : "error",
        result: res.ok ? res.data : null,
        error: res.ok ? null : res.error,
        elapsedMs: res.ok ? res.data.elapsedMs : 0,
        fetchedAll: res.ok,
      };
      tab.results = tab.results.map((r, i) => (i === idx ? replacement : r));
    } finally {
      tab.running = false;
      tab.runningRequestId = null;
    }
  },

  openWithDdl(title: string, ddl: string, plsqlMeta: PlsqlMeta | null = null): void {
    const existing = _tabs.find(t => t.title === title);
    if (existing) {
      existing.sql = ddl;
      existing.plsqlMeta = plsqlMeta;
      existing.packageSpec = undefined;
      existing.packageActiveTab = undefined;
      existing.specMeta = undefined;
      existing.results = [];
      existing.activeResultId = null;
      existing.filePath = null;
      existing.savedContent = null;
      existing.isDirty = false;
      _activeId = existing.id;
      if (!_drawerOpen) _drawerOpen = true;
      return;
    }
    const id = crypto.randomUUID();
    const tab: SqlTab = {
      id,
      kind: "sql",
      title,
      sql: ddl,
      results: [],
      activeResultId: null,
      running: false,
      runningRequestId: null,
      splitterError: null,
      filePath: null,
      isDirty: false,
      savedContent: null,
      plsqlMeta,
      packageSpec: undefined,
      packageActiveTab: undefined,
      specMeta: undefined,
      connectionId: null,
    };
    _tabs = [..._tabs, tab];
    _activeId = id;
    if (!_drawerOpen) _drawerOpen = true;
  },

  async commit(): Promise<void> {
    const t0 = Date.now();
    const res = await connectionCommit();
    if (!res.ok) throw new Error(res.error.message ?? "Commit failed");
    clearTxStateLocal();
    const idx = _tabs.findIndex((t) => t.id === _activeId);
    if (idx >= 0) {
      const entry: TabResult = {
        id: crypto.randomUUID(),
        statementIndex: _tabs[idx].results.length,
        sqlPreview: "COMMIT",
        sqlOriginal: null,
        status: "commit",
        result: null,
        error: null,
        elapsedMs: Date.now() - t0,
        dbmsOutput: null,
        compileErrors: null,
        explainNodes: null,
        fetchedAll: false,
      };
      _tabs[idx] = { ..._tabs[idx], results: [..._tabs[idx].results, entry] };
    }
  },

  async rollback(): Promise<void> {
    const t0 = Date.now();
    const res = await connectionRollback();
    if (!res.ok) throw new Error(res.error.message ?? "Rollback failed");
    clearTxStateLocal();
    const idx = _tabs.findIndex((t) => t.id === _activeId);
    if (idx >= 0) {
      const entry: TabResult = {
        id: crypto.randomUUID(),
        statementIndex: _tabs[idx].results.length,
        sqlPreview: "ROLLBACK",
        sqlOriginal: null,
        status: "rollback",
        result: null,
        error: null,
        elapsedMs: Date.now() - t0,
        dbmsOutput: null,
        compileErrors: null,
        explainNodes: null,
        fetchedAll: false,
      };
      _tabs[idx] = { ..._tabs[idx], results: [..._tabs[idx].results, entry] };
    }
  },

  reset(): void {
    _tabs = [];
    _activeId = null;
    _drawerOpen = false;
    _queryCounter = 0;
    _logCollapsed = false;
    _connectionId = null;
    _connectionName = null;
    _connectionUsername = null;
    _connectionHost = null;
    _connectionEnv = null;
    _autoExplainMode = "manual";
    _pendingConfirm = null;
    _pendingUnsafeDml = null;
    clearTxStateLocal();
    _editorExpanded = false;
  },
};

export async function runExplain(sql: string): Promise<void> {
  const tab = _tabs.find((t) => t.id === _activeId);
  if (!tab) return;
  const res = await explainPlanGet(sql);
  const resultId = crypto.randomUUID();
  const tabResult: TabResult = {
    id: resultId,
    statementIndex: 0,
    sqlPreview: "EXPLAIN PLAN",
    sqlOriginal: sql,
    status: res.ok ? "explain" : "error",
    result: null,
    error: res.ok ? null : res.error,
    elapsedMs: 0,
    dbmsOutput: null,
    compileErrors: null,
    explainNodes: res.ok ? res.data.nodes : null,
    fetchedAll: false,
  };
  const t = _tabs.find((x) => x.id === _activeId);
  if (!t) return;
  t.results = [...t.results, tabResult];
  t.activeResultId = resultId;
  _tabs = [..._tabs];
}

export function setActiveResult(tabId: string, resultId: string): void {
  const tab = _tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (!tab.results.some((r) => r.id === resultId)) return;
  tab.activeResultId = resultId;
  _tabs = [..._tabs];
}

export function retryAutoExplain(tabId: string, resultId: string, sql: string): void {
  const t = _tabs.find((x) => x.id === tabId);
  if (!t) return;
  const r = t.results.find((x) => x.id === resultId);
  if (!r) return;
  r.explainError = undefined;
  _tabs = [..._tabs];
  explainPlanGet(sql).then((er) => {
    const t2 = _tabs.find((x) => x.id === tabId);
    if (!t2) return;
    const r2 = t2.results.find((x) => x.id === resultId);
    if (!r2) return;
    if (er.ok) {
      r2.explainNodes = er.data.nodes;
      r2.explainError = undefined;
    } else {
      r2.explainError = er.error?.message ?? "Explain plan failed";
    }
    _tabs = [..._tabs];
  });
}

export function addProcResults(result: ProcExecuteResult): void {
  const tab = _tabs.find((t) => t.id === _activeId);
  if (!tab) {
    console.warn("addProcResults: no active tab to attach results to");
    return;
  }

  const logLines: string[] = [
    ...result.outParams.map((p) => `OUT ${p.name} = ${p.value}`),
    ...result.dbmsOutput,
  ];

  let lastId: string | null = null;

  if (result.refCursors.length > 0) {
    for (let ri = 0; ri < result.refCursors.length; ri++) {
      const rc = result.refCursors[ri];
      const id = crypto.randomUUID();
      tab.results = [
        ...tab.results,
        {
          id,
          statementIndex: 0,
          sqlPreview: `REF CURSOR: ${rc.name}`,
          sqlOriginal: null,
          status: "ok",
          result: { columns: rc.columns, rows: rc.rows, rowCount: rc.rows.length, elapsedMs: 0 },
          error: null,
          elapsedMs: 0,
          dbmsOutput: ri === 0 && logLines.length > 0 ? logLines : null,
          compileErrors: null,
          explainNodes: null,
          fetchedAll: false,
        },
      ];
      lastId = id;
    }
  } else {
    const id = crypto.randomUUID();
    tab.results = [
      ...tab.results,
      {
        id,
        statementIndex: 0,
        sqlPreview: "Procedure executed",
        sqlOriginal: null,
        status: "ok",
        result: null,
        error: null,
        elapsedMs: 0,
        dbmsOutput: logLines.length > 0 ? logLines : ["(no output)"],
        compileErrors: null,
        explainNodes: null,
        fetchedAll: false,
      },
    ];
    lastId = id;
  }

  if (lastId) tab.activeResultId = lastId;
  _tabs = [..._tabs];
}
