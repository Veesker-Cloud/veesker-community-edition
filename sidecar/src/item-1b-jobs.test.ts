// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ── schedulerJobsList + schedulerJobDetails + legacyJobDetails + schedulerJobDdl
// ── schedulerProgramDetails + schedulerScheduleDetails + schedulerJobPrivCheck
// ── schedulerJobRun + schedulerJobEnable + schedulerJobDisable
// ── dbmsJobRun + dbmsJobBroken + dbmsJobUnbroken unit tests ───────────────────
//
// Real getSessionSafety / setSessionSafety are passed through the mock so that
// ai.test.ts (which may load ai.ts after this mock is registered on Linux/macOS
// CI) continues to see live state updates via setSessionSafety.

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
  schedulerJobsList,
  schedulerJobDetails,
  legacyJobDetails,
  schedulerJobDdl,
  schedulerProgramDetails,
  schedulerScheduleDetails,
  schedulerJobPrivCheck,
  schedulerJobRun,
  schedulerJobEnable,
  schedulerJobDisable,
  dbmsJobRun,
  dbmsJobBroken,
  dbmsJobUnbroken,
} from "./oracle";
import { RpcCodedError, JOB_RUN_PROD_REQUIRES_CONFIRMATION, JOB_DISABLE_PROD_REQUIRES_CONFIRMATION, INVALID_IDENTIFIER } from "./errors";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
  setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });
});

// ── schedulerJobsList ─────────────────────────────────────────────────────────

describe("schedulerJobsList — DBA_SCHEDULER_JOBS + DBA_JOBS legacy", () => {
  it("returns scheduler jobs array", async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{
          OWNER: "HR", JOB_NAME: "GATHER_STATS", JOB_TYPE: "PLSQL_BLOCK",
          STATE: "SCHEDULED", ENABLED: "TRUE", RUN_COUNT: 5, FAILURE_COUNT: 0,
          NEXT_RUN_DATE: "2026-05-11", SCHEDULE_NAME: null, PROGRAM_NAME: null, COMMENTS: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await schedulerJobsList({ owner: "HR" });

    expect(result.jobs[0].name).toBe("GATHER_STATS");
    expect(result.jobs[0].enabled).toBe(true);
    expect(result.jobs[0].runCount).toBe(5);
  });

  it("returns legacy jobs array", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          JOB: 42, OWNER: "HR", JOB_ACTION: "BEGIN NULL; END;",
          NEXT_DATE: "2026-05-11", BROKEN: "N", FAILURES: 0, INTERVAL: "SYSDATE + 1",
        }],
      });

    const result = await schedulerJobsList({ owner: "HR" });

    expect(result.legacyJobs[0].jobId).toBe(42);
    expect(result.legacyJobs[0].broken).toBe(false);
  });

  it("ORA-942 fallback for DBA_SCHEDULER_JOBS — ALL returns jobs", async () => {
    // Call order: #1=DBA_SCHEDULER_JOBS (fail), #2=DBA_JOBS legacy, #3=ALL_SCHEDULER_JOBS, #4=USER_SCHEDULER_JOBS
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({ rows: [] }) // DBA_JOBS legacy
      .mockResolvedValueOnce({ rows: [{ OWNER: "HR", JOB_NAME: "GATHER_STATS", JOB_TYPE: "PLSQL_BLOCK", STATE: "SCHEDULED", ENABLED: "TRUE", RUN_COUNT: 1, FAILURE_COUNT: 0, NEXT_RUN_DATE: null, SCHEDULE_NAME: null, PROGRAM_NAME: null, COMMENTS: null }] }) // ALL
      .mockResolvedValueOnce({ rows: [] }); // USER (empty — no supplement needed)

    const result = await schedulerJobsList({ owner: "HR" });

    expect(result.jobs.length).toBeGreaterThan(0);
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("supplements with USER_SCHEDULER_JOBS when ALL_SCHEDULER_JOBS returns empty", async () => {
    // DBA fails → DBA_JOBS legacy empty → ALL_SCHEDULER_JOBS empty → USER_SCHEDULER_JOBS has jobs
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" }) // DBA_SCHEDULER_JOBS
      .mockResolvedValueOnce({ rows: [] }) // DBA_JOBS (legacy, parallel)
      .mockResolvedValueOnce({ rows: [] }) // ALL_SCHEDULER_JOBS (no rows for user without CREATE JOB priv)
      .mockResolvedValueOnce({ // USER_SCHEDULER_JOBS — always returns current user's jobs
        rows: [{
          OWNER: "GIMBIAS", JOB_NAME: "NIGHTLY_BACKUP", JOB_TYPE: "PLSQL_BLOCK",
          STATE: "SCHEDULED", ENABLED: "TRUE", RUN_COUNT: 3, FAILURE_COUNT: 0,
          NEXT_RUN_DATE: null, SCHEDULE_NAME: null, PROGRAM_NAME: null, COMMENTS: null,
        }],
      });

    const result = await schedulerJobsList({ owner: "GIMBIAS" });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].name).toBe("NIGHTLY_BACKUP");
    expect(result.jobs[0].owner).toBe("GIMBIAS");
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("deduplicates when ALL and USER return overlapping jobs", async () => {
    const jobRow = {
      OWNER: "GIMBIAS", JOB_NAME: "SHARED_JOB", JOB_TYPE: "PLSQL_BLOCK",
      STATE: "SCHEDULED", ENABLED: "TRUE", RUN_COUNT: 1, FAILURE_COUNT: 0,
      NEXT_RUN_DATE: null, SCHEDULE_NAME: null, PROGRAM_NAME: null, COMMENTS: null,
    };
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942 }) // DBA_SCHEDULER_JOBS
      .mockResolvedValueOnce({ rows: [] }) // DBA_JOBS legacy
      .mockResolvedValueOnce({ rows: [jobRow] }) // ALL_SCHEDULER_JOBS
      .mockResolvedValueOnce({ rows: [jobRow] }); // USER_SCHEDULER_JOBS same job

    const result = await schedulerJobsList({ owner: "GIMBIAS" });

    expect(result.jobs).toHaveLength(1); // deduped — not 2
    expect(result.jobs[0].name).toBe("SHARED_JOB");
  });

  it("both ORA-942 returns empty arrays", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" });

    const result = await schedulerJobsList({ owner: "HR" });

    expect(result.jobs).toHaveLength(0);
    expect(result.legacyJobs).toHaveLength(0);
  });

  it("returns empty arrays when both sources have no rows", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await schedulerJobsList({ owner: "HR" });

    expect(result.jobs.length).toBe(0);
    expect(result.legacyJobs.length).toBe(0);
  });
});

// ── schedulerJobDetails ───────────────────────────────────────────────────────

describe("schedulerJobDetails — single job metadata", () => {
  it("returns full job details when found", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        OWNER: "HR", JOB_NAME: "GATHER_STATS", JOB_TYPE: "PLSQL_BLOCK",
        JOB_ACTION: "BEGIN GATHER; END;", STATE: "SCHEDULED", ENABLED: "TRUE",
        RUN_COUNT: 3, FAILURE_COUNT: 1, MAX_FAILURES: null, RETRY_COUNT: null,
        MAX_RUNS: null, LAST_RUN_DURATION: null, NEXT_RUN_DATE: "2026-05-11",
        START_DATE: null, END_DATE: null, SCHEDULE_NAME: null, SCHEDULE_TYPE: null,
        REPEAT_INTERVAL: null, PROGRAM_NAME: "STATS_PROG", PROGRAM_TYPE: null,
        JOB_CLASS: null, RESTARTABLE: "FALSE", LOGGING_LEVEL: "RUNS", COMMENTS: null,
      }],
    });

    const result = await schedulerJobDetails({ owner: "HR", name: "GATHER_STATS" });

    expect(result.job!.name).toBe("GATHER_STATS");
    expect(result.job!.enabled).toBe(true);
    expect(result.job!.programName).toBe("STATS_PROG");
  });

  it("returns null when not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await schedulerJobDetails({ owner: "HR", name: "MISSING" });

    expect(result.job).toBeNull();
  });

  it("ORA-942 fallback to ALL_SCHEDULER_JOBS", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{
          OWNER: "HR", JOB_NAME: "GATHER_STATS", JOB_TYPE: "PLSQL_BLOCK",
          JOB_ACTION: null, STATE: "SCHEDULED", ENABLED: "TRUE",
          RUN_COUNT: 1, FAILURE_COUNT: 0, MAX_FAILURES: null, RETRY_COUNT: null,
          MAX_RUNS: null, LAST_RUN_DURATION: null, NEXT_RUN_DATE: null,
          START_DATE: null, END_DATE: null, SCHEDULE_NAME: null, SCHEDULE_TYPE: null,
          REPEAT_INTERVAL: null, PROGRAM_NAME: null, PROGRAM_TYPE: null,
          JOB_CLASS: null, RESTARTABLE: "FALSE", LOGGING_LEVEL: null, COMMENTS: null,
        }],
      });

    const result = await schedulerJobDetails({ owner: "HR", name: "GATHER_STATS" });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(result.job).not.toBeNull();
  });

  it("rethrows non-942 errors as RpcCodedError", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 1031, message: "insufficient privileges" });

    let caught: unknown = null;
    try {
      await schedulerJobDetails({ owner: "HR", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ── legacyJobDetails ──────────────────────────────────────────────────────────

describe("legacyJobDetails — DBA_JOBS single entry", () => {
  it("returns full legacy job details", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        JOB: 42, OWNER: "HR", JOB_ACTION: "BEGIN NULL; END;",
        NEXT_DATE: "2026-05-11", NEXT_SEC: "00:00:00",
        BROKEN: "N", FAILURES: 2, INTERVAL: "SYSDATE+1",
        LAST_DATE: "2026-05-10", LAST_SEC: "12:00:00",
      }],
    });

    const result = await legacyJobDetails({ jobId: 42, owner: "HR" });

    expect(result.job!.jobId).toBe(42);
    expect(result.job!.broken).toBe(false);
    expect(result.job!.failures).toBe(2);
  });

  it("returns null when not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await legacyJobDetails({ jobId: 99, owner: "HR" });

    expect(result.job).toBeNull();
  });

  it("ORA-942 fallback to USER_JOBS", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{
          JOB: 42, OWNER: "HR", JOB_ACTION: "BEGIN NULL; END;",
          NEXT_DATE: "2026-05-11", NEXT_SEC: "00:00:00",
          BROKEN: "N", FAILURES: 0, INTERVAL: "SYSDATE+1",
          LAST_DATE: null, LAST_SEC: null,
        }],
      });

    const result = await legacyJobDetails({ jobId: 42, owner: "HR" });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(result.job).not.toBeNull();
  });
});

// ── schedulerJobDdl ───────────────────────────────────────────────────────────

describe("schedulerJobDdl — DBMS_METADATA + legacy fallback", () => {
  it("returns DBMS_METADATA DDL when available", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DDL: "BEGIN\n  -- JOB DDL\nEND;" }],
    });

    const result = await schedulerJobDdl({ owner: "HR", name: "GATHER_STATS" });

    expect(result.ddl).toContain("JOB DDL");
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("returns comment for legacy=true without calling execute", async () => {
    const result = await schedulerJobDdl({ owner: "HR", name: "LEGACY_42", legacy: true });

    expect(result.ddl).toContain("Legacy DBMS_JOB");
    expect(result.ddl).toContain("DDL not available");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("ORA-31603 fallback returns informational comment", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 31603, message: "object not found" });

    const result = await schedulerJobDdl({ owner: "HR", name: "GATHER_STATS" });

    expect(result.ddl).toContain("HR.GATHER_STATS");
  });

  it("ORA-39200 fallback returns informational comment", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 39200, message: "not supported" });

    const result = await schedulerJobDdl({ owner: "HR", name: "GATHER_STATS" });

    expect(result.ddl).toContain("HR.GATHER_STATS");
  });

  it("rethrows other errors", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 4031, message: "out of shared memory" });

    let caught: unknown = null;
    try {
      await schedulerJobDdl({ owner: "HR", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
  });
});

// ── schedulerProgramDetails ───────────────────────────────────────────────────

describe("schedulerProgramDetails — DBA_SCHEDULER_PROGRAMS", () => {
  it("returns program details when found", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        OWNER: "HR", PROGRAM_NAME: "STATS_PROG", PROGRAM_TYPE: "PLSQL_BLOCK",
        PROGRAM_ACTION: "BEGIN GATHER; END;", NUMBER_OF_ARGUMENTS: 0,
        ENABLED: "TRUE", COMMENTS: null,
      }],
    });

    const result = await schedulerProgramDetails({ owner: "HR", programName: "STATS_PROG" });

    expect(result.program!.programName).toBe("STATS_PROG");
    expect(result.program!.enabled).toBe(true);
  });

  it("returns null when not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await schedulerProgramDetails({ owner: "HR", programName: "MISSING" });

    expect(result.program).toBeNull();
  });

  it("ORA-942 fallback to ALL_SCHEDULER_PROGRAMS", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{
          OWNER: "HR", PROGRAM_NAME: "STATS_PROG", PROGRAM_TYPE: "PLSQL_BLOCK",
          PROGRAM_ACTION: "BEGIN GATHER; END;", NUMBER_OF_ARGUMENTS: 0,
          ENABLED: "TRUE", COMMENTS: null,
        }],
      });

    const result = await schedulerProgramDetails({ owner: "HR", programName: "STATS_PROG" });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(result.program).not.toBeNull();
  });
});

// ── schedulerScheduleDetails ──────────────────────────────────────────────────

describe("schedulerScheduleDetails — DBA_SCHEDULER_SCHEDULES", () => {
  it("returns schedule details when found", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        OWNER: "HR", SCHEDULE_NAME: "NIGHTLY", SCHEDULE_TYPE: "CALENDAR",
        START_DATE: "2026-01-01", REPEAT_INTERVAL: "FREQ=DAILY;BYHOUR=2",
        END_DATE: null, COMMENTS: null,
      }],
    });

    const result = await schedulerScheduleDetails({ owner: "HR", scheduleName: "NIGHTLY" });

    expect(result.schedule!.scheduleName).toBe("NIGHTLY");
  });

  it("returns null when not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await schedulerScheduleDetails({ owner: "HR", scheduleName: "MISSING" });

    expect(result.schedule).toBeNull();
  });
});

// ── schedulerJobPrivCheck ─────────────────────────────────────────────────────

describe("schedulerJobPrivCheck — SESSION_PRIVS", () => {
  it("returns hasCreateAnyJob=true when granted", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ HAS_CREATE_ANY_JOB: 1, HAS_MANAGE_SCHEDULER: 0 }],
    });

    const result = await schedulerJobPrivCheck();

    expect(result.hasCreateAnyJob).toBe(true);
    expect(result.hasManageScheduler).toBe(false);
  });

  it("returns hasManageScheduler=true when granted", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ HAS_CREATE_ANY_JOB: 0, HAS_MANAGE_SCHEDULER: 1 }],
    });

    const result = await schedulerJobPrivCheck();

    expect(result.hasManageScheduler).toBe(true);
  });

  it("returns both false when no privs", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await schedulerJobPrivCheck();

    expect(result.hasCreateAnyJob).toBe(false);
    expect(result.hasManageScheduler).toBe(false);
  });
});

// ── schedulerJobRun ───────────────────────────────────────────────────────────

describe("schedulerJobRun — DBMS_SCHEDULER.RUN_JOB + env guard", () => {
  it("uses bind variables :owner and :name (not string interpolation)", async () => {
    await schedulerJobRun({ owner: "HR", name: "GATHER_STATS" });

    const sql = mockExecute.mock.calls[0][0] as string;
    const binds = mockExecute.mock.calls[0][1] as Record<string, unknown>;

    expect(sql).toContain(":owner");
    expect(sql).toContain(":name");
    expect(sql).not.toContain("HR.GATHER_STATS");
    expect(binds.owner).toBe("HR");
    expect(binds.name).toBe("GATHER_STATS");
  });

  it("uses use_current_session => FALSE", async () => {
    await schedulerJobRun({ owner: "HR", name: "GATHER_STATS" });

    const sql = mockExecute.mock.calls[0][0] as string;

    expect(sql).toContain("use_current_session => FALSE");
  });

  it("throws JOB_RUN_PROD_REQUIRES_CONFIRMATION when env=prod without confirm", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });

    let caught: unknown = null;
    try {
      await schedulerJobRun({ owner: "HR", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect((caught as RpcCodedError).code).toBe(JOB_RUN_PROD_REQUIRES_CONFIRMATION);
  });

  it("proceeds when env=prod and confirmedProdRun=true", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });

    let caught: unknown = null;
    try {
      await schedulerJobRun({ owner: "HR", name: "GATHER_STATS", confirmedProdRun: true });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("proceeds when env=dev without confirmedProdRun", async () => {
    setSessionSafety({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false });

    let caught: unknown = null;
    try {
      await schedulerJobRun({ owner: "HR", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeNull();
  });

  it("throws INVALID_IDENTIFIER for invalid owner", async () => {
    let caught: unknown = null;
    try {
      await schedulerJobRun({ owner: "'; DROP TABLE--", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ── schedulerJobEnable ────────────────────────────────────────────────────────

describe("schedulerJobEnable — DBMS_SCHEDULER.ENABLE", () => {
  it("uses :owner and :name bind variables", async () => {
    await schedulerJobEnable({ owner: "HR", name: "GATHER_STATS" });

    const sql = mockExecute.mock.calls[0][0] as string;

    expect(sql).toContain(":owner");
    expect(sql).toContain(":name");
    expect(sql).not.toContain("HR.GATHER_STATS");
  });

  it("no prod-confirm required (proceeds on prod directly)", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });

    let caught: unknown = null;
    try {
      await schedulerJobEnable({ owner: "HR", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("throws INVALID_IDENTIFIER for invalid name", async () => {
    let caught: unknown = null;
    try {
      await schedulerJobEnable({ owner: "HR", name: "'; DROP TABLE--" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ── schedulerJobDisable ───────────────────────────────────────────────────────

describe("schedulerJobDisable — DBMS_SCHEDULER.DISABLE + env guard", () => {
  it("uses :owner and :name bind variables", async () => {
    await schedulerJobDisable({ owner: "HR", name: "GATHER_STATS" });

    const sql = mockExecute.mock.calls[0][0] as string;

    expect(sql).toContain(":owner");
    expect(sql).toContain(":name");
  });

  it("throws JOB_DISABLE_PROD_REQUIRES_CONFIRMATION when env=prod without confirm", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });

    let caught: unknown = null;
    try {
      await schedulerJobDisable({ owner: "HR", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect((caught as RpcCodedError).code).toBe(JOB_DISABLE_PROD_REQUIRES_CONFIRMATION);
  });

  it("proceeds on prod with confirmedProdDisable=true", async () => {
    setSessionSafety({ env: "prod", readOnly: false, psdpm: false, warnUnsafeDml: false });

    let caught: unknown = null;
    try {
      await schedulerJobDisable({ owner: "HR", name: "GATHER_STATS", confirmedProdDisable: true });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeNull();
  });

  it("throws INVALID_IDENTIFIER for invalid owner", async () => {
    let caught: unknown = null;
    try {
      await schedulerJobDisable({ owner: "'; DROP TABLE--", name: "GATHER_STATS" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect((caught as RpcCodedError).code).toBe(INVALID_IDENTIFIER);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ── dbmsJobRun ────────────────────────────────────────────────────────────────

describe("dbmsJobRun — DBMS_JOB.RUN", () => {
  it("uses :job_id bind variable", async () => {
    await dbmsJobRun({ jobId: 42 });

    const sql = mockExecute.mock.calls[0][0] as string;
    const binds = mockExecute.mock.calls[0][1] as Record<string, unknown>;

    expect(sql).toContain(":job_id");
    expect(binds).toEqual({ job_id: 42 });
  });
});

// ── dbmsJobBroken ─────────────────────────────────────────────────────────────

describe("dbmsJobBroken — DBMS_JOB.BROKEN(TRUE)", () => {
  it("passes TRUE and :job_id bind", async () => {
    await dbmsJobBroken({ jobId: 42 });

    const sql = mockExecute.mock.calls[0][0] as string;
    const binds = mockExecute.mock.calls[0][1] as Record<string, unknown>;

    expect(sql).toContain(":job_id");
    expect(sql).toContain("TRUE");
    expect(binds).toEqual({ job_id: 42 });
  });
});

// ── dbmsJobUnbroken ───────────────────────────────────────────────────────────

describe("dbmsJobUnbroken — DBMS_JOB.BROKEN(FALSE)", () => {
  it("passes FALSE and SYSDATE", async () => {
    await dbmsJobUnbroken({ jobId: 42 });

    const sql = mockExecute.mock.calls[0][0] as string;

    expect(sql).toContain("FALSE");
    expect(sql).toContain("SYSDATE");
  });
});
