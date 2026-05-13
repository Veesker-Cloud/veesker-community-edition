// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { beforeEach, describe, expect, test, vi } from "vitest";
import { CommandExecutor, type ExecutorContext } from "./executor";
import { CommandModeState } from "./state.svelte";
import type { Result } from "$lib/workspace";
import type { SharedExecResult } from "./types";

const appendCommandHistoryMock = vi.fn();
const loadCommandHistoryMock = vi.fn();
const readCommandScriptMock = vi.fn();
const loadScriptMock = vi.fn();

vi.mock("./history", () => ({
  appendCommandHistory: (...args: unknown[]) =>
    appendCommandHistoryMock(...args),
  loadCommandHistory: (...args: unknown[]) =>
    loadCommandHistoryMock(...args),
  readCommandScript: (...args: unknown[]) => readCommandScriptMock(...args),
}));

vi.mock("./script-runner", async () => {
  const actual =
    await vi.importActual<typeof import("./script-runner")>("./script-runner");
  return {
    ...actual,
    loadScript: (...args: unknown[]) => loadScriptMock(...args),
  };
});

function makeOk(data: Partial<SharedExecResult> = {}): Result<SharedExecResult> {
  return {
    ok: true,
    data: {
      rows: [],
      columns: [],
      rowCount: 0,
      elapsedMs: 0,
      dbmsOutput: [],
      warnings: [],
      ...data,
    },
  };
}

function makeErr(code: number, message: string): Result<SharedExecResult> {
  return { ok: false, error: { code, message } };
}

function buildContext(
  overrides: Partial<ExecutorContext> = {},
): {
  ctx: ExecutorContext;
  runSql: ReturnType<typeof vi.fn>;
  runPlsql: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
} {
  const runSql = vi.fn(async () => makeOk());
  const runPlsql = vi.fn(async () => makeOk());
  const commit = vi.fn(async () => ({ ok: true, data: undefined }) as Result<void>);
  const rollback = vi.fn(async () => ({ ok: true, data: undefined }) as Result<void>);
  const onExit = vi.fn();
  const ctx: ExecutorContext = {
    connectionId: "conn-1",
    user: "SCOTT",
    service: "ORCL",
    isProductionLocked: false,
    runSql,
    runPlsql,
    commit,
    rollback,
    onExit,
    ...overrides,
  };
  return { ctx, runSql, runPlsql, commit, rollback, onExit };
}

beforeEach(() => {
  appendCommandHistoryMock.mockReset();
  appendCommandHistoryMock.mockResolvedValue(1);
  loadCommandHistoryMock.mockReset();
  loadCommandHistoryMock.mockResolvedValue({ entries: [], inaccessibleCount: 0, historyDisabled: false });
  readCommandScriptMock.mockReset();
  loadScriptMock.mockReset();
});

describe("CommandExecutor — SQL roundtrip", () => {
  test("happy path: select roundtrip pushes sql-result + history ok", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    runSql.mockResolvedValue(
      makeOk({
        rows: [["1"]],
        columns: [{ name: "1", dataType: "NUMBER" }],
        rowCount: 1,
        elapsedMs: 12,
        dbmsOutput: [],
        warnings: [],
      }),
    );
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SELECT 1 FROM dual;");
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(runSql.mock.calls[0][0]).toBe("SELECT 1 FROM dual");
    expect(runSql.mock.calls[0][1]).toEqual({ origin: "user_typed" });
    const sqlResults = state.transcript.filter((e) => e.kind === "sql-result");
    expect(sqlResults.length).toBe(1);
    expect(appendCommandHistoryMock).toHaveBeenCalledWith(
      "conn-1",
      "SELECT 1 FROM dual",
      "user_typed",
      "ok",
      12,
    );
  });

  test("SQL error path: pushes error entry + history error", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    runSql.mockResolvedValue(makeErr(-31000, "ORA-00942: table or view does not exist"));
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SELECT broken;");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    expect(appendCommandHistoryMock).toHaveBeenCalledWith(
      "conn-1",
      "SELECT broken",
      "user_typed",
      "error",
      null,
    );
  });

  test("multi-line SQL: line 1 incomplete, line 2 executes once", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    runSql.mockResolvedValue(makeOk({ rowCount: 1, elapsedMs: 5 }));
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SELECT 1");
    expect(runSql).not.toHaveBeenCalled();
    expect(state.partialBuffer.length).toBeGreaterThan(0);
    await exec.feedLine("FROM dual;");
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(runSql.mock.calls[0][0]).toBe("SELECT 1\nFROM dual");
    expect(state.partialBuffer).toBe("");
  });
});

describe("CommandExecutor — non-executing kinds", () => {
  test("blank line: no execution, no history, no transcript", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("");
    await exec.feedLine("   ");
    expect(runSql).not.toHaveBeenCalled();
    expect(appendCommandHistoryMock).not.toHaveBeenCalled();
    expect(state.transcript.length).toBe(0);
  });

  test("comment line: no execution, no history, no transcript", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("-- a comment");
    await exec.feedLine("REM another");
    expect(runSql).not.toHaveBeenCalled();
    expect(appendCommandHistoryMock).not.toHaveBeenCalled();
    expect(state.transcript.length).toBe(0);
  });

  test("parser-level error (EXIT abc): error transcript, no history", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("EXIT abc");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    expect(appendCommandHistoryMock).not.toHaveBeenCalled();
  });
});

describe("CommandExecutor — PL/SQL block", () => {
  test("BEGIN..END;/ runs once with full block text", async () => {
    const state = new CommandModeState();
    const { ctx, runPlsql, runSql } = buildContext();
    runPlsql.mockResolvedValue(
      makeOk({ elapsedMs: 7, dbmsOutput: ["hi"] }),
    );
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("BEGIN");
    await exec.feedLine("dbms_output.put_line('hi');");
    await exec.feedLine("END;");
    expect(runPlsql).not.toHaveBeenCalled();
    expect(state.pendingBlock).toBe(true);
    await exec.feedLine("/");
    expect(runSql).not.toHaveBeenCalled();
    expect(runPlsql).toHaveBeenCalledTimes(1);
    const submitted = runPlsql.mock.calls[0][0];
    expect(submitted).toContain("BEGIN");
    expect(submitted).toContain("END;");
    const plsqlResults = state.transcript.filter(
      (e) => e.kind === "plsql-result",
    );
    expect(plsqlResults.length).toBe(1);
    const dbms = state.transcript.filter((e) => e.kind === "dbms-output");
    expect(dbms.length).toBe(1);
    if (dbms[0].kind === "dbms-output") {
      expect(dbms[0].text).toBe("hi\n");
    }
  });
});

describe("CommandExecutor — SET", () => {
  test("SET PAGESIZE 50 updates state", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SET PAGESIZE 50");
    expect(state.settings.pagesize).toBe(50);
  });

  test("SET PAGESIZE notanumber pushes error and does not change settings", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    const before = state.settings.pagesize;
    await exec.feedLine("SET PAGESIZE notanumber");
    expect(state.settings.pagesize).toBe(before);
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
  });

  test("SET ECHO ON / OFF toggles boolean", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SET ECHO ON");
    expect(state.settings.echo).toBe(true);
    await exec.feedLine("SET ECHO OFF");
    expect(state.settings.echo).toBe(false);
  });
});

describe("CommandExecutor — SHOW", () => {
  test("SHOW LINESIZE renders current value as info", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SHOW LINESIZE");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain("linesize");
      expect(infos[0].text).toContain("80");
    }
  });

  test("SHOW ALL renders every setting on its own line", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SHOW ALL");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain("linesize");
      expect(infos[0].text).toContain("pagesize");
      expect(infos[0].text).toContain("feedback");
      expect(infos[0].text).toContain("heading");
      expect(infos[0].text).toContain("timing");
      expect(infos[0].text).toContain("echo");
    }
  });
});

describe("CommandExecutor — DEFINE / UNDEFINE", () => {
  test("DEFINE x = 5 sets the variable", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("DEFINE x = 5");
    expect(state.defines.x).toBe("5");
  });

  test("DEFINE without args lists all defines", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("DEFINE x = 5");
    await exec.feedLine("DEFINE y = hello");
    state.transcript = [];
    await exec.feedLine("DEFINE");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain('DEFINE x = "5"');
      expect(infos[0].text).toContain('DEFINE y = "hello"');
    }
  });

  test("UNDEFINE x removes the variable", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("DEFINE x = 5");
    await exec.feedLine("UNDEFINE x");
    expect(state.defines.x).toBeUndefined();
  });
});

describe("CommandExecutor — PROMPT / EXIT / HOST", () => {
  test("PROMPT Hello world emits info text", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("PROMPT Hello world");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toBe("Hello world\n");
    }
  });

  test("EXIT 0 calls onExit(0)", async () => {
    const state = new CommandModeState();
    const { ctx, onExit } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("EXIT 0");
    expect(onExit).toHaveBeenCalledWith(0);
  });

  test("EXIT (no arg) calls onExit(0)", async () => {
    const state = new CommandModeState();
    const { ctx, onExit } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("EXIT");
    expect(onExit).toHaveBeenCalledWith(0);
  });

  test("HOST ls produces error entry, no execution", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("HOST ls");
    expect(runSql).not.toHaveBeenCalled();
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    if (errors[0].kind === "error") {
      expect(errors[0].code).toBe("SP2-HOST-DISABLED");
    }
  });

  test("! shell escape (parsed as HOST) also blocked", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("!ls");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
  });
});

describe("CommandExecutor — CLEAR", () => {
  test("CLEAR SCREEN wipes transcript", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    state.appendTranscript({ kind: "info", text: "leftover\n" });
    state.appendTranscript({ kind: "info", text: "leftover2\n" });
    expect(state.transcript.length).toBe(2);
    await exec.feedLine("CLEAR SCREEN");
    expect(state.transcript.length).toBe(0);
  });

  test("CLEAR BUFFER is a no-op", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    state.appendTranscript({ kind: "info", text: "x\n" });
    await exec.feedLine("CLEAR BUFFER");
    expect(state.transcript.length).toBe(1);
  });
});

describe("CommandExecutor — Script execution (@)", () => {
  test("@/path/to/file.sql runs lines with origin script", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    runSql.mockResolvedValue(makeOk({ rowCount: 0, elapsedMs: 1 }));
    loadScriptMock.mockResolvedValue({
      path: "/path/to/file.sql",
      lines: ["SELECT 1 FROM dual;"],
      raw: "SELECT 1 FROM dual;\n",
    });
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("@/path/to/file.sql");
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(runSql.mock.calls[0][1]).toEqual({ origin: "script" });
    const calls = appendCommandHistoryMock.mock.calls;
    const scriptCall = calls.find((c) => c[2] === "script");
    expect(scriptCall).toBeDefined();
  });

  test("@nested.sql at scriptDepth=5 short-circuits with recursion error", async () => {
    const state = new CommandModeState();
    state.scriptDepth = 5;
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("@nested.sql");
    expect(loadScriptMock).not.toHaveBeenCalled();
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    if (errors[0].kind === "error") {
      expect(errors[0].code).toBe("SP2-RECURSION-LIMIT");
    }
  });

  test("@<missing> surfaces SP2-0310 if loadScript throws", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    loadScriptMock.mockRejectedValue(new Error("ENOENT"));
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("@/missing.sql");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    if (errors[0].kind === "error") {
      expect(errors[0].code).toBe("SP2-0310");
    }
  });
});

describe("CommandExecutor — reset / loadInitialHistory", () => {
  test("reset() clears partial state", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SELECT 1");
    expect(state.partialBuffer.length).toBeGreaterThan(0);
    expect(state.pendingBlock).toBe(false);
    exec.reset();
    expect(state.partialBuffer).toBe("");
    expect(state.pendingBlock).toBe(false);
    expect(exec.isInBlock()).toBe(false);
  });

  test("loadInitialHistory populates state.history", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    loadCommandHistoryMock.mockResolvedValue({
      entries: [
        {
          id: 1,
          connectionId: "conn-1",
          ts: 1000,
          command: "SELECT 1 FROM dual",
          origin: "user_typed",
          status: "ok",
          durationMs: 12,
        },
      ],
      inaccessibleCount: 0,
    });
    const exec = new CommandExecutor(state, ctx);
    await exec.loadInitialHistory();
    expect(state.history.length).toBe(1);
    expect(state.history[0].command).toBe("SELECT 1 FROM dual");
  });

  test("loadInitialHistory shows alert when inaccessible rows exist", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    loadCommandHistoryMock.mockResolvedValue({ entries: [], inaccessibleCount: 3, historyDisabled: false });
    const exec = new CommandExecutor(state, ctx);
    await exec.loadInitialHistory();
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    expect((infos[0] as { kind: "info"; text: string }).text).toContain("3 queries inaccessible");
  });

  test("loadInitialHistory shows disabled banner when keychain unavailable", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    loadCommandHistoryMock.mockResolvedValue({ entries: [], inaccessibleCount: 0, historyDisabled: true });
    const exec = new CommandExecutor(state, ctx);
    await exec.loadInitialHistory();
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    expect((infos[0] as { kind: "info"; text: string }).text).toContain("HISTORY DISABLED");
    expect((infos[0] as { kind: "info"; text: string }).text).toContain("Keychain unavailable");
  });

  test("loadInitialHistory swallows backend errors", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    loadCommandHistoryMock.mockRejectedValue(new Error("offline"));
    const exec = new CommandExecutor(state, ctx);
    await exec.loadInitialHistory();
    expect(state.history.length).toBe(0);
  });
});

describe("CommandExecutor — connection state directives", () => {
  test("CONNECT pushes deferred error", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("CONNECT scott/tiger");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    if (errors[0].kind === "error") {
      expect(errors[0].code).toBe("SP2-CONNECT-DEFERRED");
    }
  });

  test("DISCONNECT pushes deferred error", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("DISCONNECT");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    if (errors[0].kind === "error") {
      expect(errors[0].code).toBe("SP2-DISCONNECT-DEFERRED");
    }
  });
});

describe("CommandExecutor — SPOOL / EDIT / WHENEVER / COLUMN / ACCEPT", () => {
  test("SPOOL myfile.txt sets path and warns deferred", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SPOOL myfile.txt");
    expect(state.spoolPath).toBe("myfile.txt");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain("deferred to D.3");
    }
  });

  test("SPOOL OFF clears path", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SPOOL myfile.txt");
    await exec.feedLine("SPOOL OFF");
    expect(state.spoolPath).toBeNull();
  });

  test("EDIT pushes 'not supported' info", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("EDIT");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain("not supported");
    }
  });

  test("WHENEVER pushes deferred info", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("WHENEVER SQLERROR EXIT");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
  });

  test("COL/COLUMN pushes deferred-to-D.3 info", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("COLUMN ename FORMAT A20");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain("D.3");
    }
  });

  test("ACCEPT pushes deferred-to-D.2 info", async () => {
    const state = new CommandModeState();
    const { ctx } = buildContext();
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("ACCEPT name PROMPT 'Name?'");
    const infos = state.transcript.filter((e) => e.kind === "info");
    expect(infos.length).toBe(1);
    if (infos[0].kind === "info") {
      expect(infos[0].text).toContain("D.2");
    }
  });
});

describe("CommandExecutor — DBMS_OUTPUT propagation + PSDPM lock", () => {
  test("SQL execution with dbmsOutput pushes a separate dbms-output entry", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    runSql.mockResolvedValue(
      makeOk({
        rows: [],
        columns: [],
        rowCount: 0,
        elapsedMs: 1,
        dbmsOutput: ["line1", "line2"],
        warnings: [],
      }),
    );
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("SELECT 1 FROM dual;");
    const dbms = state.transcript.filter((e) => e.kind === "dbms-output");
    expect(dbms.length).toBe(1);
    if (dbms[0].kind === "dbms-output") {
      expect(dbms[0].text).toBe("line1\nline2\n");
    }
  });

  test("PSDPM hard-lock surfaces error AND appends history with status=error", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    runSql.mockResolvedValue(makeErr(-32050, "PSDPM hard-locked: production connection"));
    const exec = new CommandExecutor(state, ctx);
    await exec.feedLine("DROP TABLE prod_data;");
    const errors = state.transcript.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    expect(appendCommandHistoryMock).toHaveBeenCalledWith(
      "conn-1",
      "DROP TABLE prod_data",
      "user_typed",
      "error",
      null,
    );
  });
});

describe("CommandExecutor — busy flag", () => {
  test("busy is true while runSql is in flight and false afterwards", async () => {
    const state = new CommandModeState();
    const { ctx, runSql } = buildContext();
    let resolveFn!: (r: Result<SharedExecResult>) => void;
    runSql.mockReturnValue(
      new Promise<Result<SharedExecResult>>((resolve) => {
        resolveFn = resolve;
      }),
    );
    const exec = new CommandExecutor(state, ctx);
    const inflight = exec.feedLine("SELECT 1 FROM dual;");
    await Promise.resolve();
    expect(state.busy).toBe(true);
    resolveFn(makeOk({ rowCount: 0, elapsedMs: 1 }));
    await inflight;
    expect(state.busy).toBe(false);
  });
});
