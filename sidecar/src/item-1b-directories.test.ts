// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// ── directoriesList + directoryDetails unit tests ─────────────────────────────
// Both functions call withActiveSession → we mock the session module so tests
// run without an Oracle connection.

const mockExecute = mock(() => Promise.resolve({ rows: [] }));
const mockConn = { execute: mockExecute } as any;

mock.module("./state", () => ({
  getActiveSession: () => mockConn,
  getSessionSafety: () => ({ env: "dev", readOnly: false, psdpm: false, warnUnsafeDml: false }),
}));

afterAll(() => mock.restore());

import { directoriesList, directoryDetails } from "./oracle";
import { RpcCodedError } from "./errors";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
});

// ── directoriesList ───────────────────────────────────────────────────────────

describe("directoriesList — DBA_DIRECTORIES", () => {
  beforeEach(() => mockExecute.mockReset());

  it("returns directories array when DBA_DIRECTORIES is accessible", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { DIRECTORY_NAME: "DATA_PUMP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/dpdump" },
        { DIRECTORY_NAME: "ORACLE_OCM_CONFIG_DIR2", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/ccr/hosts" },
      ],
    });

    const result = await directoriesList();

    expect(result.directories).toHaveLength(2);
    expect(result.directories[0].name).toBe("DATA_PUMP_DIR");
    expect(result.directories[0].owner).toBe("SYS");
    expect(result.directories[0].path).toBe("/opt/oracle/dpdump");
  });

  it("falls back to ALL_DIRECTORIES on DBA_DIRECTORIES ORA-00942", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{ DIRECTORY_NAME: "BACKUP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/backup" }],
      });

    const result = await directoriesList();

    expect(result.directories).toHaveLength(1);
    expect(result.directories[0].name).toBe("BACKUP_DIR");
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-942 errors from DBA_DIRECTORIES", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 904, message: "invalid column" });

    let caught: unknown = null;
    try {
      await directoriesList();
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("returns empty directories array when DBA_DIRECTORIES has no rows", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await directoriesList();

    expect(result.directories).toHaveLength(0);
  });
});

// ── directoryDetails ─────────────────────────────────────────────────────────

describe("directoryDetails — path + grants", () => {
  beforeEach(() => mockExecute.mockReset());

  it("returns detail with path and owner when directory is found", async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ DIRECTORY_NAME: "DATA_PUMP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/dpdump" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await directoryDetails({ name: "DATA_PUMP_DIR" });

    expect(result.detail).not.toBeNull();
    expect(result.detail!.name).toBe("DATA_PUMP_DIR");
    expect(result.detail!.owner).toBe("SYS");
    expect(result.detail!.path).toBe("/opt/oracle/dpdump");
  });

  it("returns grants array from dba_tab_privs", async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ DIRECTORY_NAME: "DATA_PUMP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/dpdump" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { GRANTEE: "HR", PRIVILEGE: "READ" },
          { GRANTEE: "HR", PRIVILEGE: "WRITE" },
        ],
      });

    const result = await directoryDetails({ name: "DATA_PUMP_DIR" });

    expect(result.detail!.grants).toHaveLength(2);
    expect(result.detail!.grants[0]).toEqual({ grantee: "HR", privilege: "READ" });
    expect(result.detail!.grants[1]).toEqual({ grantee: "HR", privilege: "WRITE" });
  });

  it("grants query uses table_schema = SYS to avoid cross-object name collision", async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ DIRECTORY_NAME: "DATA_PUMP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/dpdump" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await directoryDetails({ name: "DATA_PUMP_DIR" });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    const grantsSQL = mockExecute.mock.calls[1][0] as string;
    expect(grantsSQL).toContain("table_schema = 'SYS'");
    expect(grantsSQL).toContain(":name");
  });

  it("returns null detail when directory is not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await directoryDetails({ name: "MISSING_DIR" });

    expect(result.detail).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("returns null detail (not throw) when DBA_DIRECTORIES raises ORA-942", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" });

    const result = await directoryDetails({ name: "DATA_PUMP_DIR" });

    expect(result.detail).toBeNull();
  });

  it("returns empty grants array when DBA_TAB_PRIVS raises ORA-942", async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ DIRECTORY_NAME: "DATA_PUMP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/dpdump" }],
      })
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" });

    const result = await directoryDetails({ name: "DATA_PUMP_DIR" });

    expect(result.detail).not.toBeNull();
    expect(result.detail!.grants).toHaveLength(0);
  });

  it("rethrows non-942 errors from DBA_TAB_PRIVS query", async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [{ DIRECTORY_NAME: "DATA_PUMP_DIR", OWNER: "SYS", DIRECTORY_PATH: "/opt/oracle/dpdump" }],
      })
      .mockRejectedValueOnce({ errorNum: 904, message: "invalid column" });

    let caught: unknown = null;
    try {
      await directoryDetails({ name: "DATA_PUMP_DIR" });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
  });
});
