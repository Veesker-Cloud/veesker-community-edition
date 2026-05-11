// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";

// ── Item #1E: DDL/DCL Confirmation Gate ───────────────────────────────────────
// Covers: classifyDdl (2-level), enforceSafetyForStatement DDL gate,
//         dryRun pre-scan, DDL window lifecycle, env gate, ORA-01031 fallback,
//         error codes DDL_BLOCKED / DDL_UNLOCK_REQUIRED.

import {
  getSessionSafety,
  setSessionSafety,
  clearSession,
  hasSession,
  getCurrentSchema,
  setSession,
  setSessionParams,
  getSessionParams,
  withSessionLock,
  getTxState,
  resetTxState,
  recordTxModifying,
  setTxId,
  SESSION_UUID,
} from "./state";

const mockExecute = mock(() => Promise.resolve({ rows: [], metaData: [] }));
const mockConn = { execute: mockExecute, callTimeout: 0 } as any;

mock.module("./state", () => ({
  getActiveSession: () => mockConn,
  getSessionSafety,
  setSessionSafety,
  clearSession,
  hasSession,
  getCurrentSchema,
  setSession,
  setSessionParams,
  getSessionParams,
  withSessionLock,
  getTxState,
  resetTxState,
  recordTxModifying,
  setTxId,
  SESSION_UUID,
}));

afterAll(() => mock.restore());

import {
  enforceSafetyForStatement,
  ddlConfirm,
  ddlUnlock,
  _testInjectClock,
  _testResetClock,
  _testResetDdlWindow,
  sessionsListAll,
  userDetails,
  privilegesList,
} from "./oracle";
import {
  classifyDdl,
  classifySql,
} from "./sql-kind";
import {
  RpcCodedError,
  DDL_BLOCKED,
  DDL_UNLOCK_REQUIRED,
} from "./errors";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [], metaData: [] });
  setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
  _testResetDdlWindow();
  _testResetClock();
});

afterEach(() => {
  _testResetDdlWindow();
  _testResetClock();
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyDdl — 2-level sub-classification
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyDdl", () => {
  it("DROP TABLE → destructive_ddl", () => {
    expect(classifyDdl("DROP TABLE HR.EMPLOYEES")).toBe("destructive_ddl");
  });
  it("DROP VIEW → destructive_ddl", () => {
    expect(classifyDdl("DROP VIEW V_EMPLOYEES")).toBe("destructive_ddl");
  });
  it("DROP SEQUENCE → destructive_ddl", () => {
    expect(classifyDdl("DROP SEQUENCE SEQ_ID")).toBe("destructive_ddl");
  });
  it("DROP INDEX → destructive_ddl", () => {
    expect(classifyDdl("DROP INDEX IDX_EMP_ID")).toBe("destructive_ddl");
  });
  it("DROP PROCEDURE → destructive_ddl", () => {
    expect(classifyDdl("DROP PROCEDURE CALC_BONUS")).toBe("destructive_ddl");
  });
  it("TRUNCATE TABLE → destructive_ddl", () => {
    expect(classifyDdl("TRUNCATE TABLE HR.EMPLOYEES")).toBe("destructive_ddl");
  });
  it("ALTER TABLE ... DROP COLUMN → destructive_ddl", () => {
    expect(classifyDdl("ALTER TABLE EMPLOYEES DROP COLUMN MANAGER_ID")).toBe("destructive_ddl");
  });
  it("ALTER TABLE ... DROP CONSTRAINT → destructive_ddl", () => {
    expect(classifyDdl("ALTER TABLE EMPLOYEES DROP CONSTRAINT PK_EMP")).toBe("destructive_ddl");
  });
  it("ALTER TABLE ... DROP PARTITION → destructive_ddl", () => {
    expect(classifyDdl("ALTER TABLE SALES DROP PARTITION P_2020")).toBe("destructive_ddl");
  });
  it("ALTER TABLE ... ADD COLUMN → ddl (non-destructive)", () => {
    expect(classifyDdl("ALTER TABLE EMPLOYEES ADD COLUMN PHONE VARCHAR2(20)")).toBe("ddl");
  });
  it("CREATE TABLE → ddl", () => {
    expect(classifyDdl("CREATE TABLE NEW_TABLE (ID NUMBER)")).toBe("ddl");
  });
  it("GRANT SELECT → ddl", () => {
    expect(classifyDdl("GRANT SELECT ON HR.EMPLOYEES TO ANALYST")).toBe("ddl");
  });
  it("REVOKE SELECT → ddl", () => {
    expect(classifyDdl("REVOKE SELECT ON HR.EMPLOYEES FROM ANALYST")).toBe("ddl");
  });
  it("COMMENT ON TABLE → comment", () => {
    expect(classifyDdl("COMMENT ON TABLE HR.EMPLOYEES IS 'Main employee table'")).toBe("comment");
  });
  it("COMMENT ON COLUMN → comment", () => {
    expect(classifyDdl("COMMENT ON COLUMN HR.EMPLOYEES.SALARY IS 'Monthly salary'")).toBe("comment");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error codes
// ─────────────────────────────────────────────────────────────────────────────
describe("error codes", () => {
  it("DDL_BLOCKED = -32041", () => {
    expect(DDL_BLOCKED).toBe(-32041);
  });
  it("DDL_UNLOCK_REQUIRED = -32042", () => {
    expect(DDL_UNLOCK_REQUIRED).toBe(-32042);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dryRun flag [OBRIGATÓRIO]
// ─────────────────────────────────────────────────────────────────────────────
describe("enforceSafetyForStatement — dryRun flag", () => {
  beforeEach(() => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });
  });

  it("dryRun:true returns DdlRiskLevel for destructive_ddl instead of throwing", () => {
    const result = enforceSafetyForStatement("DROP TABLE T", { dryRun: true });
    expect(result).toBe("destructive_ddl");
  });

  it("dryRun:true returns DdlRiskLevel for normal DDL instead of throwing", () => {
    const result = enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)", { dryRun: true });
    expect(result).toBe("ddl");
  });

  it("dryRun:true returns undefined for COMMENT (no gate)", () => {
    const result = enforceSafetyForStatement("COMMENT ON TABLE T IS 'x'", { dryRun: true });
    expect(result).toBeUndefined();
  });

  it("dryRun:true returns undefined for DML (not DDL)", () => {
    const result = enforceSafetyForStatement("DELETE FROM T WHERE ID = 1", { dryRun: true });
    expect(result).toBeUndefined();
  });

  it("dryRun:false with no window throws DDL_BLOCKED for normal DDL", () => {
    expect(() =>
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)", { dryRun: false })
    ).toThrow(RpcCodedError);
    try {
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)", { dryRun: false });
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_BLOCKED);
    }
  });

  it("dryRun:true does NOT open a window (subsequent non-dryRun still throws)", () => {
    enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)", { dryRun: true });
    expect(() =>
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)", { dryRun: false })
    ).toThrow(RpcCodedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DDL window lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe("DDL window lifecycle", () => {
  beforeEach(() => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });
  });

  it("no window → throws DDL_UNLOCK_REQUIRED for destructive DDL", () => {
    try {
      enforceSafetyForStatement("DROP TABLE T");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_UNLOCK_REQUIRED);
    }
  });

  it("no window → throws DDL_BLOCKED for normal DDL", () => {
    try {
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_BLOCKED);
    }
  });

  it("ddlConfirm('destructive_ddl') → destructive DDL passes", () => {
    ddlConfirm({ kind: "destructive_ddl" });
    expect(() => enforceSafetyForStatement("DROP TABLE T")).not.toThrow();
  });

  it("ddlConfirm('ddl') → normal DDL passes", () => {
    ddlConfirm({ kind: "ddl" });
    expect(() => enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)")).not.toThrow();
  });

  it("ddlConfirm('ddl') → destructive DDL still throws DDL_UNLOCK_REQUIRED", () => {
    ddlConfirm({ kind: "ddl" });
    try {
      enforceSafetyForStatement("DROP TABLE T");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_UNLOCK_REQUIRED);
    }
  });

  it("ddlConfirm('destructive_ddl') → covers normal DDL too", () => {
    ddlConfirm({ kind: "destructive_ddl" });
    expect(() => enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)")).not.toThrow();
  });

  it("window expires → throws again after TTL", () => {
    let fakeTime = Date.now();
    _testInjectClock({ now: () => fakeTime });
    ddlConfirm({ kind: "ddl" });
    expect(() => enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)")).not.toThrow();
    fakeTime += 5 * 60 * 1000 + 1; // advance past 5 min TTL
    try {
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_BLOCKED);
    }
  });

  it("ddlUnlock() closes window immediately", () => {
    ddlConfirm({ kind: "ddl" });
    expect(() => enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)")).not.toThrow();
    ddlUnlock();
    try {
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_BLOCKED);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Env gate
// ─────────────────────────────────────────────────────────────────────────────
describe("DDL gate — env rules", () => {
  it("env=dev: DDL passes freely without window", () => {
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
    expect(() => enforceSafetyForStatement("DROP TABLE T")).not.toThrow();
  });

  it("env=local: DDL passes freely without window", () => {
    setSessionSafety({ env: "local", readOnly: false, psdpm: false, warnUnsafeDml: false });
    expect(() => enforceSafetyForStatement("DROP TABLE T")).not.toThrow();
  });

  it("env=staging: normal DDL → DDL_BLOCKED without window", () => {
    setSessionSafety({ env: "staging", readOnly: false, psdpm: false, warnUnsafeDml: false });
    try {
      enforceSafetyForStatement("CREATE TABLE T (ID NUMBER)");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_BLOCKED);
    }
  });

  it("env=staging: destructive DDL → DDL_UNLOCK_REQUIRED without window", () => {
    setSessionSafety({ env: "staging", readOnly: false, psdpm: false, warnUnsafeDml: false });
    try {
      enforceSafetyForStatement("DROP TABLE T");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_UNLOCK_REQUIRED);
    }
  });

  it("env=prod: normal DDL → DDL_BLOCKED without window", () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });
    try {
      enforceSafetyForStatement("GRANT SELECT ON T TO U");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as RpcCodedError).code).toBe(DDL_BLOCKED);
    }
  });

  it("COMMENT passes in all envs without window", () => {
    for (const env of ["dev", "staging", "prod", "local"]) {
      setSessionSafety({ env, readOnly: false, psdpm: false, warnUnsafeDml: false });
      _testResetDdlWindow();
      expect(() => enforceSafetyForStatement("COMMENT ON TABLE T IS 'x'")).not.toThrow();
    }
  });

  it("env=dev: dryRun returns level (dev still classifies)", () => {
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
    expect(enforceSafetyForStatement("DROP TABLE T", { dryRun: true })).toBe("destructive_ddl");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch dryRun pre-scan [OBRIGATÓRIO]
// ─────────────────────────────────────────────────────────────────────────────
describe("batch dryRun pre-scan", () => {
  beforeEach(() => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });
  });

  it("DDL+DML mixed: dryRun returns DDL level only for DDL statements", () => {
    const stmts = [
      "SELECT 1 FROM DUAL",
      "INSERT INTO T VALUES (1)",
      "DROP TABLE T",
      "CREATE TABLE T2 (ID NUMBER)",
    ];
    const risks = stmts.map((s) => enforceSafetyForStatement(s, { dryRun: true }));
    expect(risks).toEqual([undefined, undefined, "destructive_ddl", "ddl"]);
  });

  it("batch all DML: no DDL risks returned", () => {
    const stmts = ["DELETE FROM T WHERE ID = 1", "UPDATE T SET X = 1 WHERE ID = 2"];
    const risks = stmts.map((s) => enforceSafetyForStatement(s, { dryRun: true }));
    expect(risks.every((r) => r === undefined)).toBe(true);
  });

  it("batch with COMMENT: comment does not appear in risks", () => {
    const risks = [
      "COMMENT ON TABLE T IS 'test'",
      "DROP TABLE T",
    ].map((s) => enforceSafetyForStatement(s, { dryRun: true }));
    expect(risks[0]).toBeUndefined();
    expect(risks[1]).toBe("destructive_ddl");
  });

  it("worstLevel: destructive_ddl if any statement is destructive", () => {
    const stmts = ["CREATE TABLE T (ID NUMBER)", "DROP TABLE T2"];
    const risks = stmts.map((s) => enforceSafetyForStatement(s, { dryRun: true }));
    const worstLevel = risks.includes("destructive_ddl") ? "destructive_ddl" : "ddl";
    expect(worstLevel).toBe("destructive_ddl");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORA-01031 fallback [OBRIGATÓRIO]
// ─────────────────────────────────────────────────────────────────────────────
describe("ORA-01031 fallback", () => {
  it("sessionsListAll: ORA-01031 on V$SESSION → accessDenied:true, no throw", async () => {
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
    mockExecute.mockRejectedValue({ errorNum: 1031, message: "ORA-01031: insufficient privileges" });
    const result = await sessionsListAll({ includeAll: false });
    expect(result.sessions).toEqual([]);
    expect(result.accessDenied).toBe(true);
  });

  it("sessionsListAll: ORA-00942 on V$SESSION → accessDenied:true, no throw", async () => {
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
    mockExecute.mockRejectedValue({ errorNum: 942, message: "ORA-00942: table or view does not exist" });
    const result = await sessionsListAll({ includeAll: false });
    expect(result.sessions).toEqual([]);
    expect(result.accessDenied).toBe(true);
  });

  it("privilegesList: ORA-01031 on DBA_ views → fallbackMode:true, no throw", async () => {
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
    mockExecute.mockRejectedValue({ errorNum: 1031, message: "ORA-01031: insufficient privileges" });
    const result = await privilegesList({ schema: "HR" });
    // DBA_ROLE_PRIVS rejected → fallback attempted; fallbackMode signals reduced access
    expect(result.fallbackMode).toBe(true);
    // DBA_TAB_PRIVS rejected → flagged as access denied
    expect(result.tabPrivsAccessDenied).toBe(true);
    // No rows returned for any category
    expect(result.rolePrivs).toEqual([]);
    expect(result.sysPrivs).toEqual([]);
    expect(result.tabPrivs).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ddlConfirm return value
// ─────────────────────────────────────────────────────────────────────────────
describe("ddlConfirm", () => {
  it("returns ok:true with expiresAt and openedAt", () => {
    const res = ddlConfirm({ kind: "ddl" });
    expect(res.ok).toBe(true);
    expect(typeof res.expiresAt).toBe("number");
    expect(typeof res.openedAt).toBe("number");
    expect(res.expiresAt).toBeGreaterThan(res.openedAt);
    expect(res.expiresAt - res.openedAt).toBe(5 * 60 * 1000);
  });

  it("ddlUnlock returns ok:true", () => {
    ddlConfirm({ kind: "ddl" });
    const res = ddlUnlock();
    expect(res.ok).toBe(true);
  });
});
