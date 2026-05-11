// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ── Item #1C: Users + Sessions + Grants/Privileges ────────────────────────────
// Covers: userDetails, userProfileDetails, userQuotas, sessionsListAll,
//         sessionSqlPreview, sessionPrivCheck, sessionKill (Ajustes 1-3),
//         privilegesList, blockingChain

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

const mockExecute = mock(() => Promise.resolve({ rows: [] }));
const mockConn = { execute: mockExecute } as any;

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
  userDetails,
  userProfileDetails,
  userQuotas,
  sessionsListAll,
  sessionSqlPreview,
  sessionPrivCheck,
  sessionKill,
  privilegesList,
  blockingChain,
} from "./oracle";
import { RpcCodedError, SESSION_KILL_PROD_REQUIRES_CONFIRMATION, INVALID_SESSION_ID } from "./errors";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
  setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
});

// ── userDetails ───────────────────────────────────────────────────────────────

describe("userDetails", () => {
  it("returns null when DBA_USERS has no rows", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const result = await userDetails({ username: "SCOTT" });
    expect(result).toBeNull();
  });

  it("maps DBA_USERS row fields", async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        USERNAME: "SCOTT",
        ACCOUNT_STATUS: "OPEN",
        LOCK_DATE: null,
        EXPIRY_DATE: "2026-12-31",
        DEFAULT_TABLESPACE: "USERS",
        TEMPORARY_TABLESPACE: "TEMP",
        PROFILE: "DEFAULT",
        CREATED: "2024-01-01",
        AUTHENTICATION_TYPE: "PASSWORD",
        FALLBACK_MODE: null,
      }],
    });
    const result = await userDetails({ username: "SCOTT" });
    expect(result).not.toBeNull();
    expect(result!.username).toBe("SCOTT");
    expect(result!.accountStatus).toBe("OPEN");
    expect(result!.defaultTablespace).toBe("USERS");
  });

  it("falls back to ALL_USERS on ORA-942 and sets fallbackMode", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942 })
      .mockResolvedValueOnce({
        rows: [{ USERNAME: "SCOTT", CREATED: "2024-01-01", FALLBACK_MODE: "1" }],
      });
    const result = await userDetails({ username: "SCOTT" });
    expect(result).not.toBeNull();
    expect(result!.fallbackMode).toBe(true);
  });

  it("falls back to ALL_USERS on ORA-1031", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 1031 })
      .mockResolvedValueOnce({
        rows: [{ USERNAME: "SCOTT", CREATED: "2024-01-01", FALLBACK_MODE: "1" }],
      });
    const result = await userDetails({ username: "SCOTT" });
    expect(result).not.toBeNull();
  });

  it("propagates unexpected errors from DBA_USERS", async () => {
    mockExecute.mockRejectedValue({ errorNum: 4031 });
    await expect(userDetails({ username: "SCOTT" })).rejects.toBeDefined();
  });
});

// ── userProfileDetails ────────────────────────────────────────────────────────

describe("userProfileDetails", () => {
  it("returns accessDenied on ORA-942", async () => {
    mockExecute.mockRejectedValue({ errorNum: 942 });
    const result = await userProfileDetails({ profile: "DEFAULT" });
    expect(result.accessDenied).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  it("returns accessDenied on ORA-1031", async () => {
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    const result = await userProfileDetails({ profile: "DEFAULT" });
    expect(result.accessDenied).toBe(true);
  });

  it("maps DBA_PROFILES rows", async () => {
    mockExecute.mockResolvedValue({
      rows: [{ RESOURCE_NAME: "SESSIONS_PER_USER", LIMIT: "10" }],
    });
    const result = await userProfileDetails({ profile: "DEFAULT" });
    expect(result.accessDenied).toBe(false);
    expect(result.rows[0].resourceName).toBe("SESSIONS_PER_USER");
    expect(result.rows[0].limit).toBe("10");
  });
});

// ── userQuotas ────────────────────────────────────────────────────────────────

describe("userQuotas", () => {
  it("returns accessDenied on ORA-942", async () => {
    mockExecute.mockRejectedValue({ errorNum: 942 });
    const result = await userQuotas({ username: "SCOTT" });
    expect(result.accessDenied).toBe(true);
  });

  it("returns accessDenied on ORA-1031", async () => {
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    const result = await userQuotas({ username: "SCOTT" });
    expect(result.accessDenied).toBe(true);
  });

  it("maps quota rows", async () => {
    mockExecute.mockResolvedValue({
      rows: [{ TABLESPACE_NAME: "USERS", BYTES: 10240, MAX_BYTES: -1, BLOCKS: 10, MAX_BLOCKS: -1 }],
    });
    const result = await userQuotas({ username: "SCOTT" });
    expect(result.accessDenied).toBe(false);
    expect(result.quotas[0].tablespaceName).toBe("USERS");
    expect(result.quotas[0].bytes).toBe(10240);
    expect(result.quotas[0].maxBytes).toBe(-1);
  });
});

// ── sessionsListAll ───────────────────────────────────────────────────────────

describe("sessionsListAll", () => {
  it("returns accessDenied on ORA-942", async () => {
    mockExecute.mockRejectedValue({ errorNum: 942 });
    const result = await sessionsListAll();
    expect(result.accessDenied).toBe(true);
    expect(result.sessions).toHaveLength(0);
  });

  it("returns accessDenied on ORA-1031 (Ajuste 3)", async () => {
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    const result = await sessionsListAll();
    expect(result.accessDenied).toBe(true);
  });

  it("maps session rows including SERIAL_NUM alias", async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        SID: 42, SERIAL_NUM: 1234, USERNAME: "SCOTT",
        STATUS: "ACTIVE", WAIT_CLASS: "User I/O",
        EVENT: "db file sequential read", LAST_CALL_ET: 5,
        MACHINE: "workstation", OSUSER: "gviana",
        PROGRAM: "sqlplus", SQL_ID: "abcde12345fgh",
        BLOCKING_SESSION: null, BLOCKING_SESSION_STATUS: null,
      }],
    });
    const result = await sessionsListAll();
    expect(result.accessDenied).toBe(false);
    expect(result.sessions[0].sid).toBe(42);
    expect(result.sessions[0].serial).toBe(1234);
    expect(result.sessions[0].username).toBe("SCOTT");
    expect(result.sessions[0].status).toBe("ACTIVE");
  });

  it("propagates non-942/1031 errors", async () => {
    mockExecute.mockRejectedValue({ errorNum: 4031 });
    await expect(sessionsListAll()).rejects.toBeDefined();
  });
});

// ── sessionSqlPreview ─────────────────────────────────────────────────────────

describe("sessionSqlPreview", () => {
  it("returns null when V$SQL has no rows", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const result = await sessionSqlPreview({ sqlId: "abc" });
    expect(result.sql).toBeNull();
  });

  it("returns sql text when found", async () => {
    mockExecute.mockResolvedValue({ rows: [{ SQL_PREVIEW: "SELECT 1 FROM DUAL" }] });
    const result = await sessionSqlPreview({ sqlId: "abc" });
    expect(result.sql).toBe("SELECT 1 FROM DUAL");
  });

  it("returns null on ORA-942", async () => {
    mockExecute.mockRejectedValue({ errorNum: 942 });
    const result = await sessionSqlPreview({ sqlId: "abc" });
    expect(result.sql).toBeNull();
  });

  it("returns null on ORA-1031 (Ajuste 3)", async () => {
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    const result = await sessionSqlPreview({ sqlId: "abc" });
    expect(result.sql).toBeNull();
  });

  it("propagates non-942/1031 errors", async () => {
    mockExecute.mockRejectedValue({ errorNum: 4031 });
    await expect(sessionSqlPreview({ sqlId: "abc" })).rejects.toBeDefined();
  });
});

// ── sessionPrivCheck ──────────────────────────────────────────────────────────

describe("sessionPrivCheck", () => {
  it("returns hasAlterSystem true when COUNT=1", async () => {
    mockExecute.mockResolvedValue({ rows: [{ HAS_ALTER_SYSTEM: 1 }] });
    const result = await sessionPrivCheck();
    expect(result.hasAlterSystem).toBe(true);
  });

  it("returns hasAlterSystem false when COUNT=0", async () => {
    mockExecute.mockResolvedValue({ rows: [{ HAS_ALTER_SYSTEM: 0 }] });
    const result = await sessionPrivCheck();
    expect(result.hasAlterSystem).toBe(false);
  });

  it("returns hasAlterSystem false on ORA-942", async () => {
    mockExecute.mockRejectedValue({ errorNum: 942 });
    const result = await sessionPrivCheck();
    expect(result.hasAlterSystem).toBe(false);
  });

  it("returns hasAlterSystem false on ORA-1031 (Ajuste 3)", async () => {
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    const result = await sessionPrivCheck();
    expect(result.hasAlterSystem).toBe(false);
  });
});

// ── sessionKill ───────────────────────────────────────────────────────────────

describe("sessionKill", () => {
  // V$SESSION lookup returns non-SYS user by default
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute
      .mockResolvedValueOnce({ rows: [{ USERNAME: "SCOTT" }] }) // V$SESSION lookup
      .mockResolvedValueOnce({ rows: [] });                      // ALTER SYSTEM KILL
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
  });

  it("returns ok:true on successful kill", async () => {
    const result = await sessionKill({ sid: 42, serial: 100 });
    expect(result.ok).toBe(true);
  });

  it("truncates fractional sid/serial", async () => {
    const result = await sessionKill({ sid: 42.9, serial: 100.1 });
    expect(result.ok).toBe(true);
  });

  // Ajuste 1: upper bound MAX_SESSION_ID = 2147483647
  it("throws INVALID_SESSION_ID when sid > 2147483647 (Ajuste 1)", async () => {
    await expect(
      sessionKill({ sid: 2147483648, serial: 100 })
    ).rejects.toMatchObject({ code: INVALID_SESSION_ID });
  });

  it("throws INVALID_SESSION_ID when serial > 2147483647 (Ajuste 1)", async () => {
    await expect(
      sessionKill({ sid: 42, serial: 2147483648 })
    ).rejects.toMatchObject({ code: INVALID_SESSION_ID });
  });

  it("accepts sid == 2147483647 (boundary, Ajuste 1)", async () => {
    const result = await sessionKill({ sid: 2147483647, serial: 1 });
    expect(result.ok).toBe(true);
  });

  it("throws INVALID_SESSION_ID when sid is zero or negative", async () => {
    await expect(sessionKill({ sid: 0, serial: 1 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
    await expect(sessionKill({ sid: -1, serial: 1 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
  });

  it("throws INVALID_SESSION_ID when serial is zero or negative", async () => {
    await expect(sessionKill({ sid: 1, serial: 0 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
  });

  // Ajuste 2: block SYS/SYSTEM — guard must throw before ALTER SYSTEM is issued
  it("throws INVALID_SESSION_ID when target is SYS, ALTER SYSTEM not called (Ajuste 2)", async () => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [{ USERNAME: "SYS" }] });
    await expect(sessionKill({ sid: 1, serial: 1 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
    expect(mockExecute).toHaveBeenCalledTimes(1); // only V$SESSION lookup, no ALTER SYSTEM
  });

  it("throws INVALID_SESSION_ID when target is SYSTEM, ALTER SYSTEM not called (Ajuste 2)", async () => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [{ USERNAME: "SYSTEM" }] });
    await expect(sessionKill({ sid: 1, serial: 1 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("case-insensitive SYS guard (Ajuste 2)", async () => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [{ USERNAME: "sys" }] });
    await expect(sessionKill({ sid: 1, serial: 1 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  // Ajuste 2 + Ajuste 3: ORA-942/1031 on V$SESSION lookup → refuse (can't verify target)
  it("throws INVALID_SESSION_ID when V$SESSION lookup returns ORA-942 (Ajuste 2+3)", async () => {
    mockExecute.mockReset();
    mockExecute.mockRejectedValue({ errorNum: 942 });
    await expect(sessionKill({ sid: 42, serial: 100 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("throws INVALID_SESSION_ID when V$SESSION lookup returns ORA-1031 (Ajuste 2+3)", async () => {
    mockExecute.mockReset();
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    await expect(sessionKill({ sid: 42, serial: 100 })).rejects.toMatchObject({ code: INVALID_SESSION_ID });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("allows kill when session not found in V$SESSION (already gone)", async () => {
    mockExecute.mockReset();
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // V$SESSION lookup returns nothing
      .mockResolvedValueOnce({ rows: [] }); // ALTER SYSTEM KILL
    const result = await sessionKill({ sid: 42, serial: 100 });
    expect(result.ok).toBe(true);
  });

  // Prod env gate
  it("throws SESSION_KILL_PROD_REQUIRES_CONFIRMATION when env=prod and no confirmedProdKill", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });
    // No mockExecute setup needed — error is thrown before DB call
    await expect(sessionKill({ sid: 42, serial: 100 })).rejects.toMatchObject({
      code: SESSION_KILL_PROD_REQUIRES_CONFIRMATION,
    });
  });

  it("allows kill in prod when confirmedProdKill=true", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });
    mockExecute.mockReset();
    mockExecute
      .mockResolvedValueOnce({ rows: [{ USERNAME: "SCOTT" }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await sessionKill({ sid: 42, serial: 100, confirmedProdKill: true });
    expect(result.ok).toBe(true);
  });
});

// ── privilegesList ────────────────────────────────────────────────────────────

describe("privilegesList", () => {
  it("returns empty lists with no access denied when all queries return empty", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.rolePrivs).toHaveLength(0);
    expect(result.sysPrivs).toHaveLength(0);
    expect(result.tabPrivs).toHaveLength(0);
    expect(result.grantedTo).toHaveLength(0);
    expect(result.tabPrivsAccessDenied).toBe(false);
    expect(result.grantedToAccessDenied).toBe(false);
    expect(result.fallbackMode).toBe(false);
  });

  it("falls back to SESSION_ROLES on ORA-942 for role privs and sets fallbackMode", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942 }) // DBA_ROLE_PRIVS fails
      .mockResolvedValue({ rows: [] });          // SESSION_ROLES + rest
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.fallbackMode).toBe(true);
  });

  it("falls back to SESSION_ROLES on ORA-1031 (Ajuste 3)", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 1031 })
      .mockResolvedValue({ rows: [] });
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.fallbackMode).toBe(true);
  });

  it("sets tabPrivsAccessDenied on ORA-942 for DBA_TAB_PRIVS received", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // DBA_ROLE_PRIVS
      .mockResolvedValueOnce({ rows: [] }) // DBA_SYS_PRIVS
      .mockRejectedValueOnce({ errorNum: 942 }) // DBA_TAB_PRIVS received
      .mockResolvedValueOnce({ rows: [] }); // DBA_TAB_PRIVS given
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.tabPrivsAccessDenied).toBe(true);
    expect(result.grantedToAccessDenied).toBe(false);
  });

  it("sets grantedToAccessDenied on ORA-1031 for DBA_TAB_PRIVS given (Ajuste 3)", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // DBA_ROLE_PRIVS
      .mockResolvedValueOnce({ rows: [] }) // DBA_SYS_PRIVS
      .mockResolvedValueOnce({ rows: [] }) // DBA_TAB_PRIVS received
      .mockRejectedValueOnce({ errorNum: 1031 }); // DBA_TAB_PRIVS given
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.grantedToAccessDenied).toBe(true);
  });

  it("maps role priv row fields", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ GRANTED_ROLE: "DBA", ADMIN_OPTION: "NO", DEFAULT_ROLE: "YES" }] })
      .mockResolvedValue({ rows: [] });
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.rolePrivs[0].grantedRole).toBe("DBA");
    expect(result.rolePrivs[0].adminOption).toBe("NO");
  });

  it("maps sys priv row fields", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // DBA_ROLE_PRIVS
      .mockResolvedValueOnce({ rows: [{ PRIVILEGE: "CREATE TABLE", ADMIN_OPTION: "NO" }] })
      .mockResolvedValue({ rows: [] });
    const result = await privilegesList({ schema: "SCOTT" });
    expect(result.sysPrivs[0].privilege).toBe("CREATE TABLE");
  });
});

// ── blockingChain ─────────────────────────────────────────────────────────────

describe("blockingChain", () => {
  it("returns empty pairs with no accessDenied when no blocking sessions", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const result = await blockingChain();
    expect(result.pairs).toHaveLength(0);
    expect(result.accessDenied).toBe(false);
  });

  it("returns accessDenied on ORA-942 (Ajuste 3)", async () => {
    mockExecute.mockRejectedValue({ errorNum: 942 });
    const result = await blockingChain();
    expect(result.accessDenied).toBe(true);
    expect(result.pairs).toHaveLength(0);
  });

  it("returns accessDenied on ORA-1031 (Ajuste 3)", async () => {
    mockExecute.mockRejectedValue({ errorNum: 1031 });
    const result = await blockingChain();
    expect(result.accessDenied).toBe(true);
  });

  it("propagates non-942/1031 errors", async () => {
    mockExecute.mockRejectedValue({ errorNum: 4031 });
    await expect(blockingChain()).rejects.toBeDefined();
  });

  it("maps blocking pair row fields", async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        BLOCKED_SID: 55,
        BLOCKED_SERIAL: 200,
        BLOCKED_USER: "APP_USER",
        WAIT_CLASS: "Lock",
        EVENT: "enq: TX - row lock contention",
        SECONDS_IN_WAIT: 30,
        BLOCKER_SID: 42,
        BLOCKER_SERIAL: 100,
        BLOCKER_USER: "SCOTT",
        BLOCKER_STATUS: "INACTIVE",
      }],
    });
    const result = await blockingChain();
    expect(result.pairs).toHaveLength(1);
    const p = result.pairs[0];
    expect(p.blockedSid).toBe(55);
    expect(p.blockedSerial).toBe(200);
    expect(p.blockedUser).toBe("APP_USER");
    expect(p.waitClass).toBe("Lock");
    expect(p.event).toBe("enq: TX - row lock contention");
    expect(p.secondsInWait).toBe(30);
    expect(p.blockerSid).toBe(42);
    expect(p.blockerUser).toBe("SCOTT");
    expect(p.blockerStatus).toBe("INACTIVE");
  });

  it("handles null user fields", async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        BLOCKED_SID: 10, BLOCKED_SERIAL: 1, BLOCKED_USER: null,
        WAIT_CLASS: null, EVENT: null, SECONDS_IN_WAIT: null,
        BLOCKER_SID: 5, BLOCKER_SERIAL: 1, BLOCKER_USER: null, BLOCKER_STATUS: null,
      }],
    });
    const result = await blockingChain();
    expect(result.pairs[0].blockedUser).toBeNull();
    expect(result.pairs[0].secondsInWait).toBeNull();
  });
});
