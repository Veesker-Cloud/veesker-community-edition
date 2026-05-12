// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

/*
 * Command Mode dispatcher.
 *
 * feedLine(line) drives the CommandParser, mirrors its in-progress buffer into
 * CommandModeState (partialBuffer / pendingBlock), and dispatches the resulting
 * Parsed event:
 *   - blank / comment        → no transcript, no history
 *   - incomplete             → state mirror only
 *   - error (parser-level)   → transcript entry only
 *   - directive              → directive table (SET/SHOW/DEFINE/.../START/EXIT)
 *   - sql / plsql            → ctx.runSql / ctx.runPlsql, then format + history
 *
 * All Oracle I/O is delegated through ExecutorContext so the executor stays
 * pure and unit-testable. The renderer wires runSql/runPlsql/commit/rollback
 * to sqlEditor.runStatementShared and the connection RPCs.
 *
 * Scripts (@, @@, START) re-enter the same dispatch via dispatchScripted with
 * origin="script". scriptDepth is bumped before parseScript and decremented in
 * finally; depth ≥ 5 short-circuits with SP2-RECURSION-LIMIT.
 *
 * History is appended for every user-typed or scripted SQL/PL-SQL/directive
 * execution. Parser-level errors, blanks, comments and incompletes are NOT
 * appended (they are not real commands).
 */

import { CommandParser } from "./parser";
import { CommandModeState } from "./state.svelte";
import type { TranscriptEntry } from "./state.svelte";
import { formatRows, formatStatus, getDdlDmlMessage } from "./formatter";
import type { Parsed, CommandSettings, SharedExecResult } from "./types";
import { appendCommandHistory, clearInaccessibleHistory, loadCommandHistory } from "./history";
import { loadScript, parseScript } from "./script-runner";
import type { Result } from "$lib/workspace";

type Origin = "user_typed" | "script";

export interface ExecutorContext {
  connectionId: string;
  user: string | null;
  service: string | null;
  isProductionLocked: boolean;
  runSql: (
    sql: string,
    opts: { origin: "user_typed" | "script" },
  ) => Promise<Result<SharedExecResult>>;
  runPlsql: (
    plsql: string,
    opts: { origin: "user_typed" | "script" },
  ) => Promise<Result<SharedExecResult>>;
  commit: () => Promise<Result<void>>;
  rollback: () => Promise<Result<void>>;
  onExit?: (code: number) => void;
}

const ON_OFF_KEYS = new Set<keyof CommandSettings>([
  "feedback",
  "heading",
  "timing",
  "serveroutput",
  "echo",
  "define",
  "termout",
]);

const NUMERIC_KEYS = new Set<keyof CommandSettings>(["linesize", "pagesize"]);

const STRING_KEYS = new Set<keyof CommandSettings>(["null", "colsep", "numformat"]);

const SETTING_ALIASES: Record<string, keyof CommandSettings> = {
  LINESIZE: "linesize",
  LIN: "linesize",
  PAGESIZE: "pagesize",
  PAGES: "pagesize",
  FEEDBACK: "feedback",
  FEED: "feedback",
  HEADING: "heading",
  HEA: "heading",
  TIMING: "timing",
  TIMI: "timing",
  SERVEROUTPUT: "serveroutput",
  SEVEROUTPUT: "serveroutput",
  NULL: "null",
  COLSEP: "colsep",
  NUMFORMAT: "numformat",
  NUMF: "numformat",
  ECHO: "echo",
  DEFINE: "define",
  DEF: "define",
  TERMOUT: "termout",
  TERM: "termout",
};

const SETTING_DISPLAY_ORDER: Array<keyof CommandSettings> = [
  "linesize",
  "pagesize",
  "feedback",
  "heading",
  "timing",
  "serveroutput",
  "null",
  "colsep",
  "numformat",
  "echo",
  "define",
  "termout",
];

function parseOnOff(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toUpperCase();
  if (v === "ON") return true;
  if (v === "OFF") return false;
  return null;
}

function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function renderSettingValue(
  key: keyof CommandSettings,
  settings: CommandSettings,
): string {
  const v = settings[key];
  if (typeof v === "boolean") return v ? "ON" : "OFF";
  if (typeof v === "number") return String(v);
  return String(v);
}

function settingLabel(key: keyof CommandSettings): string {
  return key;
}

export class CommandExecutor {
  private parser = new CommandParser();

  constructor(
    private state: CommandModeState,
    private ctx: ExecutorContext,
  ) {}

  async feedLine(line: string): Promise<void> {
    const parsed = this.parser.feed(line);

    if (parsed.kind === "incomplete") {
      this.state.partialBuffer = parsed.partial;
      this.state.pendingBlock = this.parser.isInBlock();
      return;
    }

    this.state.partialBuffer = "";
    this.state.pendingBlock = false;

    await this.dispatch(parsed, "user_typed");
  }

  reset(): void {
    this.parser.reset();
    this.state.partialBuffer = "";
    this.state.pendingBlock = false;
  }

  isInBlock(): boolean {
    return this.parser.isInBlock();
  }

  async loadInitialHistory(): Promise<void> {
    try {
      const { entries, inaccessibleCount, historyDisabled } = await loadCommandHistory(this.ctx.connectionId, 1000);
      this.state.setHistory(entries);
      if (historyDisabled) {
        this.push({
          kind: "info",
          text: "[HISTORY DISABLED] Keychain unavailable — command history will not be saved this session.\n",
        });
      } else if (inaccessibleCount > 0) {
        this.push({
          kind: "info",
          text: `[SECURITY] ${inaccessibleCount} quer${inaccessibleCount === 1 ? "y" : "ies"} inaccessible — encryption key not available on this machine.\nType: CLEAR HISTORY INACCESSIBLE to remove them.\n`,
        });
      }
    } catch (e) {
      console.warn("[CommandExecutor] failed to load history:", e);
    }
  }

  private push(entry: TranscriptEntry): void {
    this.state.appendTranscript(entry);
  }

  private async dispatch(parsed: Parsed, origin: Origin): Promise<void> {
    switch (parsed.kind) {
      case "blank":
        return;
      case "comment":
        return;
      case "incomplete":
        return;
      case "error":
        this.push({ kind: "error", code: parsed.code, message: parsed.message });
        return;
      case "directive":
        await this.runDirective(parsed.name, parsed.args, parsed.raw, origin);
        return;
      case "sql":
        await this.runSqlExec(parsed.text, origin);
        return;
      case "plsql":
        await this.runPlsqlExec(parsed.text, origin);
        return;
    }
  }

  private async dispatchScripted(parsed: Parsed): Promise<void> {
    await this.dispatch(parsed, "script");
  }

  private async runSqlExec(text: string, origin: Origin): Promise<void> {
    this.state.busy = true;
    try {
      const result = await this.ctx.runSql(text, { origin });
      if (result.ok) {
        const data = result.data;
        const statusMsg =
          getDdlDmlMessage(text, data.rowCount, data.elapsedMs, this.state.settings) ??
          formatStatus(data.rowCount, data.elapsedMs, this.state.settings);
        const formatted = formatRows(data.rows, data.columns, this.state.settings) + statusMsg;
        this.push({
          kind: "sql-result",
          text: formatted,
          rowCount: data.rowCount,
          elapsedMs: data.elapsedMs,
        });
        if (data.dbmsOutput.length > 0) {
          this.push({
            kind: "dbms-output",
            text: `${data.dbmsOutput.join("\n")}\n`,
          });
        }
        await this.appendHistorySafe(text, origin, "ok", data.elapsedMs);
      } else {
        this.push({
          kind: "error",
          code: String(result.error.code),
          message: result.error.message,
        });
        await this.appendHistorySafe(text, origin, "error", null);
      }
    } finally {
      this.state.busy = false;
    }
  }

  private async runPlsqlExec(text: string, origin: Origin): Promise<void> {
    this.state.busy = true;
    try {
      const result = await this.ctx.runPlsql(text, { origin });
      if (result.ok) {
        const data = result.data;
        this.push({
          kind: "plsql-result",
          text: "PL/SQL procedure successfully completed.\n",
          elapsedMs: data.elapsedMs,
        });
        if (data.dbmsOutput.length > 0) {
          this.push({
            kind: "dbms-output",
            text: `${data.dbmsOutput.join("\n")}\n`,
          });
        }
        await this.appendHistorySafe(text, origin, "ok", data.elapsedMs);
      } else {
        this.push({
          kind: "error",
          code: String(result.error.code),
          message: result.error.message,
        });
        await this.appendHistorySafe(text, origin, "error", null);
      }
    } finally {
      this.state.busy = false;
    }
  }

  private async appendHistorySafe(
    command: string,
    origin: Origin,
    status: "ok" | "error",
    durationMs: number | null,
  ): Promise<void> {
    try {
      const entryId = await appendCommandHistory(
        this.ctx.connectionId,
        command,
        origin,
        status,
        durationMs,
      );
      this.state.appendHistory({
        id: entryId,
        connectionId: this.ctx.connectionId,
        ts: Date.now(),
        command,
        origin,
        status,
        durationMs,
      });
    } catch (e) {
      console.warn("[CommandExecutor] history append failed:", e);
    }
  }

  private async runDirective(
    name: string,
    args: string[],
    raw: string,
    origin: Origin,
  ): Promise<void> {
    switch (name) {
      case "SET":
        this.handleSet(args);
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "SHOW":
        await this.handleShow(args);
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "DEFINE":
        this.handleDefine(args);
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "UNDEFINE":
        this.handleUndefine(args);
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "COLUMN":
        this.push({
          kind: "info",
          text: "COLUMN formatting deferred to D.3\n",
        });
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "ACCEPT":
        this.push({ kind: "info", text: "ACCEPT deferred to D.2\n" });
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "PROMPT":
        this.push({ kind: "info", text: `${args[0] ?? ""}\n` });
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "EXIT": {
        const code = args.length > 0 ? Number(args[0]) : 0;
        const finalCode = Number.isFinite(code) ? code : 0;
        this.push({ kind: "info", text: "Disconnected from Oracle\n" });
        await this.appendHistorySafe(raw, origin, "ok", null);
        this.ctx.onExit?.(finalCode);
        return;
      }
      case "CONNECT":
        this.push({
          kind: "error",
          code: "SP2-CONNECT-DEFERRED",
          message:
            "CONNECT/CONN is not supported in Command Mode for D.1; use the connection picker",
        });
        await this.appendHistorySafe(raw, origin, "error", null);
        return;
      case "DISCONNECT":
        this.push({
          kind: "error",
          code: "SP2-DISCONNECT-DEFERRED",
          message:
            "DISCONNECT is not supported in Command Mode for D.1; close the tab instead",
        });
        await this.appendHistorySafe(raw, origin, "error", null);
        return;
      case "HOST":
        this.push({
          kind: "error",
          code: "SP2-HOST-DISABLED",
          message: "Host commands are disabled (Veesker security policy)",
        });
        await this.appendHistorySafe(raw, origin, "error", null);
        return;
      case "CLEAR":
        if (
          (args[0] ?? "").toUpperCase() === "HISTORY" &&
          (args[1] ?? "").toUpperCase() === "INACCESSIBLE"
        ) {
          try {
            const deleted = await clearInaccessibleHistory();
            this.push({ kind: "info", text: `${deleted} inaccessible quer${deleted === 1 ? "y" : "ies"} removed.\n` });
          } catch (e) {
            this.push({ kind: "error", code: "SP2-HISTORY-CLEAR", message: `CLEAR HISTORY INACCESSIBLE failed: ${e}` });
          }
          await this.appendHistorySafe(raw, origin, "ok", null);
          return;
        }
        this.handleClear(args);
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "SPOOL":
        this.handleSpool(args);
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "START":
        await this.executeScript(args[0] ?? "", "START");
        return;
      case "EDIT":
        this.push({
          kind: "info",
          text: "EDIT not supported in Command Mode\n",
        });
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      case "WHENEVER":
        this.push({ kind: "info", text: "WHENEVER deferred\n" });
        await this.appendHistorySafe(raw, origin, "ok", null);
        return;
      default:
        this.push({
          kind: "error",
          code: "SP2-0042",
          message: `unknown command "${raw}" - rest of line ignored`,
        });
        return;
    }
  }

  private handleSet(args: string[]): void {
    if (args.length === 0) {
      this.push({
        kind: "error",
        code: "SP2-0158",
        message: "missing SET option",
      });
      return;
    }
    const rawKey = args[0];
    const key = SETTING_ALIASES[rawKey.toUpperCase()];
    if (!key) {
      this.push({
        kind: "error",
        code: "SP2-0158",
        message: `unknown SHOW option "${rawKey}"`,
      });
      return;
    }
    const valueArg = args.slice(1).join(" ");
    if (NUMERIC_KEYS.has(key)) {
      const n = Number.parseInt(valueArg.trim(), 10);
      if (!Number.isFinite(n)) {
        this.push({
          kind: "error",
          code: "SP2-0268",
          message: `${settingLabel(key)} option ${valueArg} not a valid number`,
        });
        return;
      }
      if (key === "linesize" && (n < 1 || n > 32767)) {
        this.push({
          kind: "error",
          code: "SP2-0267",
          message: `linesize option ${n} out of range (1 .. 32767)`,
        });
        return;
      }
      if (key === "pagesize" && (n < 0 || n > 50000)) {
        this.push({
          kind: "error",
          code: "SP2-0267",
          message: `pagesize option ${n} out of range (0 .. 50000)`,
        });
        return;
      }
      this.state.setSetting(key, n as CommandSettings[typeof key]);
      return;
    }
    if (ON_OFF_KEYS.has(key)) {
      const onOff = parseOnOff(valueArg);
      if (onOff === null) {
        this.push({
          kind: "error",
          code: "SP2-0265",
          message: `${settingLabel(key)} must be set to ON or OFF`,
        });
        return;
      }
      this.state.setSetting(key, onOff as CommandSettings[typeof key]);
      return;
    }
    if (STRING_KEYS.has(key)) {
      this.state.setSetting(
        key,
        stripQuotes(valueArg) as CommandSettings[typeof key],
      );
      return;
    }
  }

  private async handleShow(args: string[]): Promise<void> {
    if (args.length === 0) {
      this.push({ kind: "error", code: "SP2-0158", message: "missing SHOW option" });
      return;
    }
    const rawKey = args[0].toUpperCase();
    if (rawKey === "ERRORS" || rawKey === "ERR") {
      await this.handleShowErrors(args.slice(1));
      return;
    }
    if (rawKey === "ALL") {
      let out = "";
      for (const k of SETTING_DISPLAY_ORDER) {
        out += `${settingLabel(k)} ${renderSettingValue(k, this.state.settings)}\n`;
      }
      this.push({ kind: "info", text: out });
      return;
    }
    const key = SETTING_ALIASES[rawKey];
    if (!key) {
      this.push({ kind: "error", code: "SP2-0158", message: `unknown SHOW option "${args[0]}"` });
      return;
    }
    this.push({ kind: "info", text: `${settingLabel(key)} ${renderSettingValue(key, this.state.settings)}\n` });
  }

  private async handleShowErrors(args: string[]): Promise<void> {
    const schema = this.ctx.user ? `${this.ctx.user.toUpperCase()}.` : "";
    let sql: string;
    let noErrMsg: string;

    if (args.length >= 2) {
      const type = args[0].toUpperCase().replace(/'/g, "''");
      const name = args[1].toUpperCase().replace(/'/g, "''");
      sql = `SELECT line, position, text FROM user_errors WHERE type = '${type}' AND name = '${name}' ORDER BY sequence`;
      noErrMsg = `No errors for ${type} ${schema}${name}\n`;
    } else if (args.length === 1) {
      const type = args[0].toUpperCase().replace(/'/g, "''");
      sql = `SELECT name, line, position, text FROM user_errors WHERE type = '${type}' ORDER BY name, sequence`;
      noErrMsg = `No errors for ${type}\n`;
    } else {
      sql = [
        "SELECT e.type, e.name, e.line, e.position, e.text",
        "FROM user_errors e",
        "JOIN user_objects o ON o.object_name = e.name AND o.object_type = e.type",
        "ORDER BY o.last_ddl_time DESC, e.name, e.sequence",
        "FETCH FIRST 50 ROWS ONLY",
      ].join(" ");
      noErrMsg = "No errors\n";
    }

    const result = await this.ctx.runSql(sql, { origin: "user_typed" });
    if (!result.ok) {
      this.push({ kind: "error", code: String(result.error.code), message: result.error.message });
      return;
    }

    const { rows } = result.data;
    if (rows.length === 0) {
      this.push({ kind: "info", text: noErrMsg });
      return;
    }

    let out = "";
    if (args.length >= 2) {
      const type = args[0].toUpperCase();
      const name = args[1].toUpperCase();
      out += `Errors for ${type} ${schema}${name}:\n\n`;
      out += "LINE/COL  ERROR\n";
      out += "--------  -------------------------------------------------------\n";
      for (const row of rows) {
        const [line, pos, text] = row as [number | null, number | null, string | null];
        out += `${`${line ?? "?"}/${pos ?? "?"}`.padEnd(8)}  ${text ?? ""}\n`;
      }
    } else if (args.length === 1) {
      const type = args[0].toUpperCase();
      out += `Errors for ${type}:\n\n`;
      out += "OBJECT                          LINE/COL  ERROR\n";
      out += "------------------------------  --------  -----------------------------------------\n";
      for (const row of rows) {
        const [name, line, pos, text] = row as [string | null, number | null, number | null, string | null];
        out += `${(name ?? "").padEnd(30)}  ${`${line ?? "?"}/${pos ?? "?"}`.padEnd(8)}  ${text ?? ""}\n`;
      }
    } else {
      for (const row of rows) {
        const [type, name, line, pos, text] = row as [string | null, string | null, number | null, number | null, string | null];
        out += `${type ?? ""} ${schema}${name ?? ""}\n  Line ${line ?? "?"}/${pos ?? "?"}: ${text ?? ""}\n`;
      }
    }

    this.push({ kind: "info", text: out });
  }

  private handleDefine(args: string[]): void {
    if (args.length === 0) {
      const keys = Object.keys(this.state.defines).sort();
      if (keys.length === 0) {
        this.push({ kind: "info", text: "" });
        return;
      }
      let out = "";
      for (const k of keys) {
        out += `DEFINE ${k} = "${this.state.defines[k]}"\n`;
      }
      this.push({ kind: "info", text: out });
      return;
    }
    if (args.length === 1) {
      const name = args[0];
      const value = this.state.defines[name];
      if (value === undefined) {
        this.push({
          kind: "error",
          code: "SP2-0135",
          message: `symbol ${name} is UNDEFINED`,
        });
        return;
      }
      this.push({ kind: "info", text: `DEFINE ${name} = "${value}"\n` });
      return;
    }
    const [name, value] = args;
    this.state.defines = { ...this.state.defines, [name]: value };
  }

  private handleUndefine(args: string[]): void {
    if (args.length === 0) {
      this.push({
        kind: "error",
        code: "SP2-0158",
        message: "missing variable name for UNDEFINE",
      });
      return;
    }
    const next = { ...this.state.defines };
    for (const name of args) {
      delete next[name];
    }
    this.state.defines = next;
  }

  private handleClear(args: string[]): void {
    const target = (args[0] ?? "").toUpperCase();
    if (target === "" || target === "SCREEN" || target === "SCR") {
      this.state.clear();
      return;
    }
    if (target === "BUFFER" || target === "BUFF") {
      return;
    }
    this.push({
      kind: "error",
      code: "SP2-0042",
      message: `unknown CLEAR target "${args[0]}"`,
    });
  }

  private handleSpool(args: string[]): void {
    const target = (args[0] ?? "").trim();
    if (target === "" || target.toUpperCase() === "OFF") {
      this.state.setSpoolPath(null);
      this.push({ kind: "info", text: "Spool off\n" });
      return;
    }
    this.state.setSpoolPath(target);
    this.push({
      kind: "info",
      text: `Spool started: ${target}\nSPOOL file output deferred to D.3 (state-only for now)\n`,
    });
  }

  private async executeScript(
    filename: string,
    _aliasUsed: string,
  ): Promise<void> {
    if (filename === "") {
      this.push({
        kind: "error",
        code: "SP2-0310",
        message: "unable to open file (script requires a filename)",
      });
      return;
    }
    if (this.state.scriptDepth >= 5) {
      this.push({
        kind: "error",
        code: "SP2-RECURSION-LIMIT",
        message: "max script depth exceeded",
      });
      return;
    }
    this.state.scriptDepth++;
    try {
      const result = await loadScript(filename);
      const events = parseScript(result.raw);
      this.push({
        kind: "info",
        text: `Loading script: ${result.path} (${result.lines.length} lines)\n`,
      });
      for (const ev of events) {
        const k = ev.parsed.kind;
        if (k === "blank" || k === "comment") continue;
        if (k === "error") {
          this.push({
            kind: "error",
            code: ev.parsed.code,
            message: ev.parsed.message,
          });
          continue;
        }
        if (this.state.settings.echo) {
          this.push({ kind: "echo", text: `${ev.rawLine}\n` });
        }
        await this.dispatchScripted(ev.parsed);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.push({
        kind: "error",
        code: "SP2-0310",
        message: `could not open script file: ${message}`,
      });
    } finally {
      this.state.scriptDepth--;
    }
  }
}
