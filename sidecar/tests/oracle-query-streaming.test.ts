// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// L3.4 + L3.3 Sprint C Onda 3 — query.execute streaming + DBMS_OUTPUT always-on.

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { setSession, clearSession } from "../src/state";
import {
  queryExecute,
  enableDbmsOutputForActiveSession,
  QUERY_STREAM_BATCH,
  type QueryResult,
  type MultiQueryResult,
  _resetRunning,
  _getRunning,
} from "../src/oracle";

function asSingle(r: QueryResult | MultiQueryResult): QueryResult {
  if ("multi" in r) throw new Error("expected single QueryResult, got MultiQueryResult");
  return r;
}

// ── stdout capture (notifications go through process.stdout.write) ────────────

let captured: { method: string; params: any }[] = [];
let writeSpy: ReturnType<typeof spyOn> | null = null;

function startCapture() {
  captured = [];
  writeSpy = spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj?.method === "string" && !("id" in obj)) {
          captured.push({ method: obj.method, params: obj.params });
        }
      } catch {
        /* not JSON — ignore */
      }
    }
    return true;
  }) as unknown as typeof process.stdout.write);
}

function stopCapture() {
  if (writeSpy) {
    writeSpy.mockRestore();
    writeSpy = null;
  }
}

beforeEach(() => {
  clearSession();
  _resetRunning();
  startCapture();
});

afterEach(() => {
  stopCapture();
  clearSession();
  _resetRunning();
});

// ── Helpers — fake Oracle connection driving cursor.getRows() ─────────────────

interface FakeCursor {
  closed: boolean;
  getRows: (n: number) => Promise<any[][]>;
  close: () => Promise<void>;
}

/**
 * Build a fake oracledb.Connection whose execute() returns a streaming
 * resultSet that yields the supplied row batches in order, then signals EOF.
 */
function fakeStreamingConn(opts: {
  metaData: any[];
  batches: any[][][];
  /** If set, throw inside getRows for the matching batch index. */
  throwOnBatch?: number;
  /** If set, called when cursor.close() is invoked. */
  onClose?: () => void;
  /** If true, always return a result without resultSet (fallback path). */
  noResultSet?: boolean;
  /** If set, drain calls return these lines (one round-trip per array). */
  drainLines?: string[][];
  /** If set, throws on user execute (still drains). */
  throwOnExecute?: Error;
}) {
  const drainQueue = [...(opts.drainLines ?? [])];
  let batchIdx = 0;
  const cursor: FakeCursor = {
    closed: false,
    getRows: async (_n: number) => {
      if (opts.throwOnBatch === batchIdx) {
        throw new Error("simulated mid-loop driver failure");
      }
      const batch = opts.batches[batchIdx];
      batchIdx++;
      if (batch === undefined) return [];
      return batch;
    },
    close: async () => {
      cursor.closed = true;
      opts.onClose?.();
    },
  };
  const conn = {
    cursor,
    execute: mock(async (sql: string, _binds?: any, options?: any) => {
      // DBMS_OUTPUT drain: BEGIN ... DBMS_OUTPUT.GET_LINES(...) END;
      if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT.GET_LINES")) {
        if (drainQueue.length === 0) {
          return { outBinds: { NUM: 0, LINES: [] } };
        }
        const lines = drainQueue.shift()!;
        return { outBinds: { NUM: lines.length, LINES: lines } };
      }
      // DBMS_OUTPUT.ENABLE
      if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT.ENABLE")) {
        return {};
      }
      if (opts.throwOnExecute) throw opts.throwOnExecute;
      if (opts.noResultSet) {
        const allRows: any[][] = [];
        for (const b of opts.batches) for (const row of b) allRows.push(row);
        return { metaData: opts.metaData, rows: allRows };
      }
      // Honour resultSet:true requests.
      if (options?.resultSet === true) {
        return { metaData: opts.metaData, resultSet: cursor };
      }
      return { metaData: opts.metaData, rows: [] };
    }),
    break: mock(async () => {}),
  } as any;
  return { conn, cursor };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("queryExecute streaming (L3.4)", () => {
  test("emits at least one query.progress notification with correct shape", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER", precision: 10, scale: 0 }];
    const batch1 = Array.from({ length: QUERY_STREAM_BATCH }, (_, i) => [i]);
    const { conn } = fakeStreamingConn({ metaData: meta, batches: [batch1] });
    setSession(conn, "SCOTT");

    await queryExecute({
      sql: "SELECT id FROM t",
      requestId: "rq-streaming-1",
      fetchAll: true,
    });

    const progress = captured.filter((c) => c.method === "query.progress");
    expect(progress.length).toBeGreaterThanOrEqual(1);
    const last = progress[progress.length - 1];
    expect(last.params.requestId).toBe("rq-streaming-1");
    expect(last.params.rowsFetched).toBeGreaterThanOrEqual(1);
    expect(typeof last.params.elapsedMs).toBe("number");
    expect(last.params.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("emits progress for multiple batches (cumulative rowsFetched)", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER", precision: 10, scale: 0 }];
    const batch = (start: number) =>
      Array.from({ length: QUERY_STREAM_BATCH }, (_, i) => [start + i]);
    const { conn } = fakeStreamingConn({
      metaData: meta,
      batches: [batch(0), batch(QUERY_STREAM_BATCH), batch(QUERY_STREAM_BATCH * 2)],
    });
    setSession(conn, "SCOTT");

    const r = asSingle(
      await queryExecute({ sql: "SELECT id FROM t", requestId: "rq-stream-N", fetchAll: true }),
    );
    expect(r.rows.length).toBe(QUERY_STREAM_BATCH * 3);

    const progress = captured.filter((c) => c.method === "query.progress");
    expect(progress.length).toBeGreaterThanOrEqual(2);
    // Cumulative: each notification's rowsFetched is monotonically non-decreasing.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].params.rowsFetched).toBeGreaterThanOrEqual(
        progress[i - 1].params.rowsFetched,
      );
    }
    expect(progress[progress.length - 1].params.rowsFetched).toBe(QUERY_STREAM_BATCH * 3);
  });

  test("cancellation between batches breaks the loop (second batch not requested)", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER", precision: 10, scale: 0 }];
    const batch1 = Array.from({ length: QUERY_STREAM_BATCH }, (_, i) => [i]);
    const batch2 = Array.from({ length: QUERY_STREAM_BATCH }, (_, i) => [i + QUERY_STREAM_BATCH]);
    let getRowsCalls = 0;
    const cursor: FakeCursor = {
      closed: false,
      getRows: async (_n: number) => {
        getRowsCalls++;
        if (getRowsCalls === 1) {
          // Trip cancel right as we hand back the first batch — the loop's
          // top-of-iteration check fires before the second getRows() call.
          const running = _getRunning();
          if (running) running.cancelled = true;
          return batch1;
        }
        return batch2;
      },
      close: async () => {
        cursor.closed = true;
      },
    };
    const conn = {
      execute: mock(async (sql: string, _b?: any, opts?: any) => {
        if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT")) {
          return { outBinds: { NUM: 0, LINES: [] } };
        }
        if (opts?.resultSet === true) return { metaData: meta, resultSet: cursor };
        return { metaData: meta, rows: [] };
      }),
      break: mock(async () => {}),
    } as any;
    setSession(conn, "SCOTT");

    await queryExecute({ sql: "SELECT id FROM t", requestId: "rq-cancel", fetchAll: true });

    expect(getRowsCalls).toBe(1);
    expect(cursor.closed).toBe(true);
  });

  test("cursor.close() runs in finally even when getRows throws", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER" }];
    const batch1 = Array.from({ length: QUERY_STREAM_BATCH }, (_, i) => [i]);
    const { conn, cursor } = fakeStreamingConn({
      metaData: meta,
      batches: [batch1, []],
      throwOnBatch: 1,
    });
    setSession(conn, "SCOTT");

    let caught: unknown = null;
    try {
      await queryExecute({ sql: "SELECT id FROM t", requestId: "rq-throw", fetchAll: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(cursor.closed).toBe(true);
  });

  test("DML statement (no resultSet) does NOT emit progress notifications", async () => {
    const conn = {
      execute: mock(async (sql: string) => {
        if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT")) {
          return { outBinds: { NUM: 0, LINES: [] } };
        }
        return { metaData: undefined, rows: undefined, rowsAffected: 5 };
      }),
      break: mock(async () => {}),
    } as any;
    setSession(conn, "SCOTT");

    const r = asSingle(
      await queryExecute({ sql: "UPDATE t SET x = 1", requestId: "rq-dml" }),
    );

    expect(r.rowCount).toBe(5);
    expect(r.dbmsOutput).toEqual([]);
    const progress = captured.filter((c) => c.method === "query.progress");
    expect(progress.length).toBe(0);
  });

  test("legacy mock (no resultSet field) falls back to single-shot path", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER" }];
    const { conn } = fakeStreamingConn({
      metaData: meta,
      batches: [[[1], [2], [3]]],
      noResultSet: true,
    });
    setSession(conn, "SCOTT");
    const r = asSingle(await queryExecute({ sql: "SELECT id FROM t" }));
    expect(r.rows).toEqual([[1], [2], [3]]);
    expect(r.rowCount).toBe(3);
  });
});

// ── DBMS_OUTPUT always-on (L3.3) ──────────────────────────────────────────────

describe("DBMS_OUTPUT always-on (L3.3)", () => {
  test("single SELECT with no output → dbmsOutput is empty array", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER" }];
    const { conn } = fakeStreamingConn({
      metaData: meta,
      batches: [[[1]]],
      drainLines: [], // no rounds → drain returns []
    });
    setSession(conn, "SCOTT");

    const r = asSingle(await queryExecute({ sql: "SELECT id FROM t", fetchAll: true }));
    expect(r.dbmsOutput).toEqual([]);
  });

  test("single SELECT after PUT_LINE → dbmsOutput populated", async () => {
    const meta = [{ name: "ID", dbTypeName: "NUMBER" }];
    const { conn } = fakeStreamingConn({
      metaData: meta,
      batches: [[[1]]],
      // First drain round delivers two lines, then the loop exits because
      // got < BATCH (it asked for 100 and got 2).
      drainLines: [["hello", "world"]],
    });
    setSession(conn, "SCOTT");

    const r = asSingle(await queryExecute({ sql: "SELECT id FROM t", fetchAll: true }));
    expect(r.dbmsOutput).toEqual(["hello", "world"]);
  });

  test("drain runs even when query fails (buffer hygiene)", async () => {
    let drainCalled = 0;
    const conn = {
      execute: mock(async (sql: string) => {
        if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT.GET_LINES")) {
          drainCalled++;
          return { outBinds: { NUM: 0, LINES: [] } };
        }
        if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT.ENABLE")) {
          return {};
        }
        throw new Error("ORA-00942: table or view does not exist");
      }),
      break: mock(async () => {}),
    } as any;
    setSession(conn, "SCOTT");

    let caught: unknown = null;
    try {
      await queryExecute({ sql: "SELECT * FROM nope" });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(drainCalled).toBeGreaterThanOrEqual(1);
  });

  test("enableDbmsOutputForActiveSession swallows execute errors", async () => {
    const conn = {
      execute: mock(async () => {
        throw new Error("boom");
      }),
      break: mock(async () => {}),
    } as any;
    setSession(conn, "SCOTT");
    // Must resolve cleanly (no throw).
    await expect(enableDbmsOutputForActiveSession()).resolves.toBeUndefined();
  });

  test("enableDbmsOutputForActiveSession is a no-op when no session is set", async () => {
    clearSession();
    await expect(enableDbmsOutputForActiveSession()).resolves.toBeUndefined();
  });

  test("multi-statement result has cumulative top-level dbmsOutput", async () => {
    let stmtIdx = 0;
    const drainQueue: string[][] = [["from-stmt-1"], ["from-stmt-2"]];
    const conn = {
      execute: mock(async (sql: string) => {
        if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT.GET_LINES")) {
          if (drainQueue.length === 0) return { outBinds: { NUM: 0, LINES: [] } };
          const lines = drainQueue.shift()!;
          return { outBinds: { NUM: lines.length, LINES: lines } };
        }
        if (typeof sql === "string" && sql.toUpperCase().includes("DBMS_OUTPUT.ENABLE")) {
          return {};
        }
        stmtIdx++;
        return {
          metaData: [{ name: "X", dbTypeName: "NUMBER" }],
          rows: [[stmtIdx]],
        };
      }),
      break: mock(async () => {}),
    } as any;
    setSession(conn, "SCOTT");

    const r = await queryExecute({
      sql: "SELECT 1 FROM dual;\nSELECT 2 FROM dual;",
      splitMulti: true,
    });
    expect("multi" in r).toBe(true);
    const mr = r as MultiQueryResult;
    expect(mr.dbmsOutput).toEqual(["from-stmt-1", "from-stmt-2"]);
    // Per-statement output is preserved for back-compat.
    expect((mr.results[0] as any).output).toEqual(["from-stmt-1"]);
    expect((mr.results[1] as any).output).toEqual(["from-stmt-2"]);
  });
});
