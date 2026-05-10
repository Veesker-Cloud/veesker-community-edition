// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ── queuesList + queueDetails + queueDdl unit tests ──────────────────────────
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

import { queuesList, queueDetails, queueDdl } from "./oracle";
import { RpcCodedError } from "./errors";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
});

// ── queuesList ────────────────────────────────────────────────────────────────

describe("queuesList — ALL_QUEUES filtered", () => {
  beforeEach(() => mockExecute.mockReset());

  it("returns queues array with payload type from ALL_QUEUE_TABLES join", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        OWNER: "HR", NAME: "NOTIFY_Q", QUEUE_TABLE: "NOTIFY_QT",
        QUEUE_TYPE: "NORMAL_QUEUE", MAX_RETRIES: 5, RETRY_DELAY: 0,
        RETENTION: 0, USER_COMMENT: null, PAYLOAD_TYPE: "SYS.AQ$_JMS_TEXT_MESSAGE",
      }],
    });

    const result = await queuesList({ owner: "HR" });

    expect(result.queues).toHaveLength(1);
    expect(result.queues[0].name).toBe("NOTIFY_Q");
    expect(result.queues[0].queueTable).toBe("NOTIFY_QT");
    expect(result.queues[0].queueType).toBe("NORMAL_QUEUE");
    expect(result.queues[0].payloadType).toBe("SYS.AQ$_JMS_TEXT_MESSAGE");
    expect(result.queues[0].maxRetries).toBe(5);
  });

  it("returns empty array on ORA-00942 (ALL_QUEUES not accessible)", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" });

    const result = await queuesList({ owner: "HR" });

    expect(result.queues).toHaveLength(0);
  });

  it("SQL filters EXCEPTION_QUEUE type", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    await queuesList({ owner: "HR" });

    const sql = mockExecute.mock.calls[0][0] as string;
    expect(sql).toContain("EXCEPTION_QUEUE");
    expect(sql).toContain("!=");
  });

  it("rethrows non-942 errors", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 4030, message: "out of process memory" });

    let caught: unknown = null;
    try {
      await queuesList({ owner: "HR" });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
  });
});

// ── queueDetails ──────────────────────────────────────────────────────────────

describe("queueDetails — single queue metadata", () => {
  beforeEach(() => mockExecute.mockReset());

  it("returns full QueueRow when queue is found", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        OWNER: "HR", NAME: "NOTIFY_Q", QUEUE_TABLE: "NOTIFY_QT",
        QUEUE_TYPE: "NORMAL_QUEUE", MAX_RETRIES: 5, RETRY_DELAY: 0,
        RETENTION: 0, USER_COMMENT: "Order notifications", PAYLOAD_TYPE: "RAW",
      }],
    });

    const result = await queueDetails({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.queue).not.toBeNull();
    expect(result.queue!.name).toBe("NOTIFY_Q");
    expect(result.queue!.userComment).toBe("Order notifications");
    expect(result.queue!.payloadType).toBe("RAW");
  });

  it("returns null when queue not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await queueDetails({ owner: "HR", name: "MISSING_Q" });

    expect(result.queue).toBeNull();
  });

  it("returns null on ORA-00942", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" });

    const result = await queueDetails({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.queue).toBeNull();
  });

  it("rethrows non-942 errors", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 1000, message: "maximum open cursors exceeded" });

    let caught: unknown = null;
    try {
      await queueDetails({ owner: "HR", name: "NOTIFY_Q" });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
  });
});

// ── queueDdl ─────────────────────────────────────────────────────────────────

describe("queueDdl — DBMS_METADATA + reconstruction fallback", () => {
  beforeEach(() => mockExecute.mockReset());

  it("returns DBMS_METADATA DDL when available", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DDL: "BEGIN\n  -- DBMS_METADATA DDL\nEND;" }],
    });

    const result = await queueDdl({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.ddl).toContain("DBMS_METADATA DDL");
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("falls back to reconstruction when DBMS_METADATA raises ORA-39200", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 39200, message: "not supported" })
      .mockResolvedValueOnce({
        rows: [{
          QUEUE_TABLE: "NOTIFY_QT", QUEUE_TYPE: "NORMAL_QUEUE",
          MAX_RETRIES: 5, RETRY_DELAY: 0, RETENTION: 0, PAYLOAD_TYPE: "RAW",
        }],
      });

    const result = await queueDdl({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.ddl).toContain("DBMS_AQADM.CREATE_QUEUE");
    expect(result.ddl).toContain("HR.NOTIFY_Q");
    expect(result.ddl).toContain("HR.NOTIFY_QT");
    expect(result.ddl).toContain("NORMAL_QUEUE");
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("reconstruction includes max_retries when present", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 39200, message: "not supported" })
      .mockResolvedValueOnce({
        rows: [{
          QUEUE_TABLE: "QT", QUEUE_TYPE: "NORMAL_QUEUE",
          MAX_RETRIES: 10, RETRY_DELAY: 30, RETENTION: 86400, PAYLOAD_TYPE: null,
        }],
      });

    const result = await queueDdl({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.ddl).toContain("max_retries");
    expect(result.ddl).toContain("10");
    expect(result.ddl).toContain("retry_delay");
    expect(result.ddl).toContain("30");
    expect(result.ddl).toContain("retention_time");
  });

  it("returns informational comment when both DBMS_METADATA and ALL_QUEUES fail", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 39200, message: "not supported" })
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" });

    const result = await queueDdl({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.ddl).toContain("HR.NOTIFY_Q");
    expect(result.ddl).toContain("DDL not available");
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("falls back to reconstruction when DBMS_METADATA raises ORA-31603 (not found)", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 31603, message: "object not found" })
      .mockResolvedValueOnce({
        rows: [{
          QUEUE_TABLE: "QT", QUEUE_TYPE: "NORMAL_QUEUE",
          MAX_RETRIES: null, RETRY_DELAY: null, RETENTION: null, PAYLOAD_TYPE: null,
        }],
      });

    const result = await queueDdl({ owner: "HR", name: "NOTIFY_Q" });

    expect(result.ddl).toContain("DBMS_AQADM.CREATE_QUEUE");
  });
});
