import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  setSession,
  clearSession,
  getTxState,
  resetTxState,
  recordTxModifying,
  setTxId,
} from "../src/state";
import { queryExecute, connectionCommit, connectionRollback, connectionTxState } from "../src/oracle";

describe("TxState (state.ts)", () => {
  beforeEach(() => {
    clearSession();
    resetTxState();
  });

  test("starts zeroed", () => {
    const s = getTxState();
    expect(s.pendingStatements).toBe(0);
    expect(s.lastTxId).toBeNull();
    expect(s.lastModifyingAt).toBeNull();
    expect(s.lastModifyingType).toBeNull();
  });

  test("recordTxModifying increments and tags", () => {
    recordTxModifying("dml", "0001.0002.0003", 1234);
    const s = getTxState();
    expect(s.pendingStatements).toBe(1);
    expect(s.lastTxId).toBe("0001.0002.0003");
    expect(s.lastModifyingAt).toBe(1234);
    expect(s.lastModifyingType).toBe("dml");

    recordTxModifying("ddl", "0001.0002.0003", 1235);
    const s2 = getTxState();
    expect(s2.pendingStatements).toBe(2);
    expect(s2.lastModifyingType).toBe("ddl");
  });

  test("resetTxState zeros everything", () => {
    recordTxModifying("dml", "x", 1);
    resetTxState();
    expect(getTxState()).toEqual({
      pendingStatements: 0,
      lastTxId: null,
      lastModifyingAt: null,
      lastModifyingType: null,
    });
  });

  test("clearSession also resets tx state", () => {
    setSession({} as any, "SCOTT");
    recordTxModifying("dml", "x", 1);
    clearSession();
    expect(getTxState().pendingStatements).toBe(0);
  });

  test("setTxId updates txId without bumping count", () => {
    recordTxModifying("dml", "old", 1);
    setTxId("new");
    const s = getTxState();
    expect(s.lastTxId).toBe("new");
    expect(s.pendingStatements).toBe(1);
  });
});

// Helper that simulates DBMS_TRANSACTION.LOCAL_TRANSACTION_ID for the tx-id
// consult round-trip in syncTxStateAfterStatement.
function fakeConnSequence(steps: Array<(...a: any[]) => any>) {
  let i = 0;
  const exec = mock(async (sql: string, _binds: any, _opts: any) => {
    const fn = steps[i++];
    if (!fn) throw new Error(`fakeConnSequence exhausted at step ${i}`);
    return fn(sql);
  });
  return { execute: exec, commit: mock(async () => {}), rollback: mock(async () => {}) } as any;
}

// Returns a step that responds to DBMS_TRANSACTION queries with a given txId
// (or null) and otherwise returns a default DDL/DML/PLSQL shape.
function txIdStep(txId: string | null) {
  return (sql: string) => {
    if (/DBMS_TRANSACTION\.LOCAL_TRANSACTION_ID/i.test(sql)) {
      return { rows: txId === null ? [{ T: null }] : [{ T: txId }] };
    }
    throw new Error(`unexpected sql in txIdStep: ${sql.slice(0, 40)}`);
  };
}

function dmlStep(rowsAffected = 1) {
  return () => ({ metaData: undefined, rows: undefined, rowsAffected });
}

function ddlStep() {
  return () => ({ metaData: undefined, rows: undefined, rowsAffected: undefined });
}

function plsqlStep() {
  return () => ({ metaData: undefined, rows: undefined, rowsAffected: undefined });
}

describe("syncTxStateAfterStatement (via queryExecute)", () => {
  beforeEach(() => {
    clearSession();
    resetTxState();
  });

  test("DML success with non-null txId increments pending", async () => {
    const conn = fakeConnSequence([
      dmlStep(1),                           // user UPDATE
      // DBMS_OUTPUT drain — drainDbmsOutput executes DBMS_OUTPUT.GET_LINES
      () => ({ outBinds: { lines: [], status: 1 } }),
      txIdStep("0001.0002.0003"),           // DBMS_TRANSACTION consult
    ]);
    setSession(conn, "SCOTT");
    await queryExecute({ sql: "UPDATE t SET x=1 WHERE id=2" });
    const s = getTxState();
    expect(s.pendingStatements).toBe(1);
    expect(s.lastTxId).toBe("0001.0002.0003");
    expect(s.lastModifyingType).toBe("dml");
  });

  test("DDL success returns null txId → resets state (Oracle implicit commit)", async () => {
    recordTxModifying("dml", "old.tx.id", 100); // prior pending DML
    const conn = fakeConnSequence([
      ddlStep(),
      () => ({ outBinds: { lines: [], status: 1 } }),
      txIdStep(null),                       // DDL implicit committed everything
    ]);
    setSession(conn, "SCOTT");
    await queryExecute({ sql: "CREATE TABLE t (id NUMBER)" });
    const s = getTxState();
    expect(s.pendingStatements).toBe(0);
    expect(s.lastTxId).toBeNull();
  });

  test("PL/SQL block with internal COMMIT → null txId → resets state", async () => {
    recordTxModifying("dml", "old", 1);
    const conn = fakeConnSequence([
      plsqlStep(),
      () => ({ outBinds: { lines: [], status: 1 } }),
      txIdStep(null),                       // block did COMMIT internally
    ]);
    setSession(conn, "SCOTT");
    await queryExecute({ sql: "BEGIN UPDATE t SET x=1; COMMIT; END;" });
    expect(getTxState().pendingStatements).toBe(0);
  });

  test("PL/SQL block with internal DML, no commit → counted as pending", async () => {
    const conn = fakeConnSequence([
      plsqlStep(),
      () => ({ outBinds: { lines: [], status: 1 } }),
      txIdStep("aa.bb.cc"),
    ]);
    setSession(conn, "SCOTT");
    await queryExecute({ sql: "BEGIN UPDATE t SET x=1; END;" });
    const s = getTxState();
    expect(s.pendingStatements).toBe(1);
    expect(s.lastModifyingType).toBe("plsql");
  });

  test("SELECT does NOT consult DBMS_TRANSACTION (optimization)", async () => {
    // Only two execute calls expected: SELECT + DBMS_OUTPUT drain.
    // No third call for txId consult.
    const conn = fakeConnSequence([
      () => ({ metaData: [{ name: "X", dbTypeName: "NUMBER" }], rows: [[1]] }),
      () => ({ outBinds: { lines: [], status: 1 } }),
    ]);
    setSession(conn, "SCOTT");
    await queryExecute({ sql: "SELECT 1 FROM DUAL" });
    expect(conn.execute.mock.calls.length).toBe(2);
    expect(getTxState().pendingStatements).toBe(0);
  });

  test("COMMIT statement (TCL) → resets state", async () => {
    recordTxModifying("dml", "old", 1);
    const conn = fakeConnSequence([
      () => ({ metaData: undefined, rows: undefined, rowsAffected: 0 }),
      () => ({ outBinds: { lines: [], status: 1 } }),
      txIdStep(null),
    ]);
    setSession(conn, "SCOTT");
    await queryExecute({ sql: "COMMIT" });
    expect(getTxState().pendingStatements).toBe(0);
  });
});

describe("connectionCommit / connectionRollback reset tx state", () => {
  beforeEach(() => {
    clearSession();
    resetTxState();
  });

  test("connectionCommit resets pending count and txId", async () => {
    recordTxModifying("dml", "x", 1);
    const conn = { commit: mock(async () => {}), rollback: mock(async () => {}) } as any;
    setSession(conn, "SCOTT");
    await connectionCommit();
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(getTxState().pendingStatements).toBe(0);
    expect(getTxState().lastTxId).toBeNull();
  });

  test("connectionRollback resets pending count and txId", async () => {
    recordTxModifying("dml", "x", 1);
    const conn = { commit: mock(async () => {}), rollback: mock(async () => {}) } as any;
    setSession(conn, "SCOTT");
    await connectionRollback();
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(getTxState().pendingStatements).toBe(0);
  });
});

describe("connectionTxState RPC", () => {
  beforeEach(() => {
    clearSession();
    resetTxState();
  });

  test("returns hasOpenTx=false with no active session", async () => {
    const r = await connectionTxState();
    expect(r.hasOpenTx).toBe(false);
    expect(r.pendingStatements).toBe(0);
    expect(r.lastTxId).toBeNull();
  });

  test("returns hasOpenTx=true with cached pending state, refreshes txId from Oracle", async () => {
    recordTxModifying("dml", "stale.tx", 100);
    const conn = fakeConnSequence([txIdStep("fresh.tx")]);
    setSession(conn, "SCOTT");
    const r = await connectionTxState();
    expect(r.hasOpenTx).toBe(true);
    expect(r.pendingStatements).toBe(1);
    expect(r.lastTxId).toBe("fresh.tx");
  });

  test("if Oracle reports null txId, state is reset (lost session / external commit)", async () => {
    recordTxModifying("dml", "stale.tx", 100);
    const conn = fakeConnSequence([txIdStep(null)]);
    setSession(conn, "SCOTT");
    const r = await connectionTxState();
    expect(r.hasOpenTx).toBe(false);
    expect(r.pendingStatements).toBe(0);
  });

  test("with no cached pending work, does NOT round-trip to Oracle", async () => {
    const exec = mock(async () => ({ rows: [] }));
    setSession({ execute: exec } as any, "SCOTT");
    const r = await connectionTxState();
    expect(r.hasOpenTx).toBe(false);
    expect(exec.mock.calls.length).toBe(0);
  });
});
