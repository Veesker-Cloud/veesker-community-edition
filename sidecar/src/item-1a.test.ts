// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── objectsList type mapping ──────────────────────────────────────────────────
// The typeMap inside objectsList converts MATERIALIZED_VIEW → 'MATERIALIZED VIEW'
// and passes all other kinds through unchanged. We verify this by calling
// objectsList with a mocked connection and inspecting the bind params.

const mockExecute = mock(() => Promise.resolve({ rows: [] }));
const mockConn = { execute: mockExecute } as any;

let _mockEnv = "dev";

mock.module("./state", () => ({
  getActiveSession: () => mockConn,
  getSessionSafety: () => ({ env: _mockEnv, readOnly: false, psdpm: false, warnUnsafeDml: false }),
}));

import { objectsList } from "./oracle";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
  _mockEnv = "dev";
});

describe("objectsList — ObjectKind to ALL_OBJECTS type mapping", () => {
  it("maps MATERIALIZED_VIEW to 'MATERIALIZED VIEW' (with space)", async () => {
    await objectsList({ owner: "SCOTT", type: "MATERIALIZED_VIEW" });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const call = mockExecute.mock.calls[0];
    const binds = call[1] as Record<string, string>;
    expect(binds.type).toBe("MATERIALIZED VIEW");
  });

  it("passes TABLE unchanged", async () => {
    await objectsList({ owner: "SCOTT", type: "TABLE" });

    const binds = mockExecute.mock.calls[0][1] as Record<string, string>;
    expect(binds.type).toBe("TABLE");
  });

  it("passes VIEW unchanged", async () => {
    await objectsList({ owner: "SCOTT", type: "VIEW" });

    const binds = mockExecute.mock.calls[0][1] as Record<string, string>;
    expect(binds.type).toBe("VIEW");
  });

  it("passes SEQUENCE unchanged", async () => {
    await objectsList({ owner: "SCOTT", type: "SEQUENCE" });

    const binds = mockExecute.mock.calls[0][1] as Record<string, string>;
    expect(binds.type).toBe("SEQUENCE");
  });
});

// ── dbLinkDdl DDL construction ────────────────────────────────────────────────
// dbLinkDdl builds the DDL string in TypeScript using query results — fully
// unit-testable by mocking the execute return value.

import { dbLinkDdl } from "./oracle";

describe("dbLinkDdl — DDL string construction", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("includes <<REPLACE_WITH_ACTUAL_PASSWORD>> in the output", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DB_LINK: "PROD_LINK", USERNAME: "SCOTT", HOST: "proddb:1521/PROD" }],
    });

    const result = await dbLinkDdl({ name: "PROD_LINK" });

    expect(result.ddl).toContain("<<REPLACE_WITH_ACTUAL_PASSWORD>>");
  });

  it("includes the WARNING comment about passwords", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DB_LINK: "PROD_LINK", USERNAME: "SCOTT", HOST: "proddb:1521/PROD" }],
    });

    const result = await dbLinkDdl({ name: "PROD_LINK" });

    expect(result.ddl).toContain("WARNING: Oracle does not expose DB Link passwords.");
    expect(result.ddl).toContain("not executable without manual edit");
  });

  it("uses <<USERNAME>> placeholder when username is null", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DB_LINK: "X_LINK", USERNAME: null, HOST: "host:1521/SVC" }],
    });

    const result = await dbLinkDdl({ name: "X_LINK" });

    expect(result.ddl).toContain("<<USERNAME>>");
    expect(result.ddl).not.toContain("CONNECT TO null");
  });

  it("uses <<HOST>> placeholder when host is null", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DB_LINK: "Y_LINK", USERNAME: "APP", HOST: null }],
    });

    const result = await dbLinkDdl({ name: "Y_LINK" });

    expect(result.ddl).toContain("<<HOST>>");
    expect(result.ddl).not.toContain("USING 'null'");
  });

  it("returns informational comment when link not found in USER_DB_LINKS", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await dbLinkDdl({ name: "MISSING_LINK" });

    expect(result.ddl).toContain("MISSING_LINK");
    expect(result.ddl).toContain("not found in USER_DB_LINKS");
  });

  it("includes the actual db_link name in the DDL", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ DB_LINK: "MY.WORLD", USERNAME: "SCOTT", HOST: "orahost:1521/XE" }],
    });

    const result = await dbLinkDdl({ name: "MY.WORLD" });

    expect(result.ddl).toContain("MY.WORLD");
    expect(result.ddl).toContain("CREATE DATABASE LINK");
  });
});

// ── mviewDetails ORA-00942 fallback ───────────────────────────────────────────

import { mviewDetails } from "./oracle";

describe("mviewDetails — ORA-00942 fallback to USER_MVIEWS", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("fallback returns detail when ALL_MVIEWS raises ORA-942", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{
          MVIEW_NAME: "EMP_MV",
          REFRESH_METHOD: "FORCE",
          REFRESH_MODE: "ON DEMAND",
          LAST_REFRESH_DATE: new Date("2026-05-01"),
          STALENESS: "STALE",
          QUERY: "SELECT * FROM employees",
        }],
      });

    const result = await mviewDetails({ owner: "SCOTT", name: "EMP_MV" });

    expect(result.detail).not.toBeNull();
    expect(result.detail!.name).toBe("EMP_MV");
  });

  it("fallback backfills owner from parameter", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{
          MVIEW_NAME: "EMP_MV",
          REFRESH_METHOD: "FORCE",
          REFRESH_MODE: "ON DEMAND",
          LAST_REFRESH_DATE: new Date("2026-05-01"),
          STALENESS: "STALE",
          QUERY: "SELECT * FROM employees",
        }],
      });

    const result = await mviewDetails({ owner: "SCOTT", name: "EMP_MV" });

    expect(result.detail!.owner).toBe("SCOTT");
  });

  it("non-942 error is rethrown", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 904, message: "invalid column" });

    let caught: unknown = null;
    try {
      await mviewDetails({ owner: "SCOTT", name: "EMP_MV" });
    } catch (e) {
      caught = e;
    }
    // withActiveSession wraps non-RpcCodedError plain objects into RpcCodedError(ORACLE_ERR).
    // We verify the error was NOT swallowed by the 942 fallback — only one execute call was made.
    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ── dbLinksList ORA-00942 fallback ────────────────────────────────────────────

import { dbLinksList } from "./oracle";

describe("dbLinksList — ORA-00942 fallback to USER_DB_LINKS", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("fallback returns DB links from USER_DB_LINKS when DBA_DB_LINKS raises ORA-942", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{ DB_LINK: "MY_LINK", USERNAME: "SCOTT", HOST: "host:1521/XE", CREATED: new Date("2026-01-01") }],
      });

    const result = await dbLinksList({ owner: "SCOTT" });

    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].name).toBe("MY_LINK");
  });

  it("fallback backfills owner from parameter", async () => {
    mockExecute
      .mockRejectedValueOnce({ errorNum: 942, message: "table or view does not exist" })
      .mockResolvedValueOnce({
        rows: [{ DB_LINK: "MY_LINK", USERNAME: "SCOTT", HOST: "host:1521/XE", CREATED: new Date("2026-01-01") }],
      });

    const result = await dbLinksList({ owner: "SCOTT" });

    expect(result.objects[0].owner).toBe("SCOTT");
  });

  it("non-942 error from DBA_DB_LINKS is rethrown", async () => {
    mockExecute.mockRejectedValueOnce({ errorNum: 904, message: "invalid column" });

    let caught: unknown = null;
    try {
      await dbLinksList({ owner: "SCOTT" });
    } catch (e) {
      caught = e;
    }
    // withActiveSession wraps non-RpcCodedError plain objects into RpcCodedError(ORACLE_ERR).
    // We verify the error was NOT swallowed by the 942 fallback — only one execute call was made.
    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ── mviewRefresh bind variable safety and env guard ───────────────────────────

import { mviewRefresh } from "./oracle";
import { MVIEW_REFRESH_PROD_REQUIRES_CONFIRMATION, RpcCodedError } from "./errors";

describe("mviewRefresh — bind variable safety and env guard", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [] });
    _mockEnv = "dev";
  });

  it("uses bind variables for mv_name and method (not string interpolation)", async () => {
    _mockEnv = "dev";
    await mviewRefresh({ owner: "SCOTT", name: "EMP_MV", method: "FORCE" });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const sql = mockExecute.mock.calls[0][0] as string;
    expect(sql).toContain(":mv_name");
    expect(sql).toContain(":method");
    expect(sql).not.toContain("SCOTT.EMP_MV");
    expect(sql).not.toContain("FORCE");
  });

  it("throws MVIEW_REFRESH_PROD_REQUIRES_CONFIRMATION when env=prod and confirmedProdRefresh is missing", async () => {
    _mockEnv = "prod";

    let caught: unknown = null;
    try {
      await mviewRefresh({ owner: "SCOTT", name: "EMP_MV", method: "FORCE" });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof RpcCodedError).toBe(true);
    expect((caught as RpcCodedError).code).toBe(MVIEW_REFRESH_PROD_REQUIRES_CONFIRMATION);
  });

  it("proceeds when env=prod and confirmedProdRefresh=true", async () => {
    _mockEnv = "prod";

    let threw = false;
    try {
      await mviewRefresh({ owner: "SCOTT", name: "EMP_MV", method: "FORCE", confirmedProdRefresh: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("proceeds without confirmedProdRefresh when env=dev", async () => {
    _mockEnv = "dev";

    let threw = false;
    try {
      await mviewRefresh({ owner: "SCOTT", name: "EMP_MV", method: "FORCE" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ── synonymDetails call shape ─────────────────────────────────────────────────

import { synonymDetails } from "./oracle";

describe("synonymDetails — call shape", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("returns detail with correct field mapping", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        SYNONYM_NAME: "EMP_SYN",
        OWNER: "SCOTT",
        TABLE_OWNER: "HR",
        TABLE_NAME: "EMPLOYEES",
        DB_LINK: null,
        DDL: "CREATE SYNONYM EMP_SYN FOR HR.EMPLOYEES;",
      }],
    });

    const result = await synonymDetails({ owner: "SCOTT", name: "EMP_SYN" });

    expect(result.detail!.name).toBe("EMP_SYN");
    expect(result.detail!.owner).toBe("SCOTT");
    expect(result.detail!.targetSchema).toBe("HR");
    expect(result.detail!.targetObject).toBe("EMPLOYEES");
  });

  it("targetDbLink is null when no DB link", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        SYNONYM_NAME: "EMP_SYN",
        OWNER: "SCOTT",
        TABLE_OWNER: "HR",
        TABLE_NAME: "EMPLOYEES",
        DB_LINK: null,
        DDL: "CREATE SYNONYM EMP_SYN FOR HR.EMPLOYEES;",
      }],
    });

    const result = await synonymDetails({ owner: "SCOTT", name: "EMP_SYN" });

    expect(result.detail!.targetDbLink).toBeNull();
  });

  it("targetDbLink is populated when DB link present", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        SYNONYM_NAME: "EMP_SYN",
        OWNER: "SCOTT",
        TABLE_OWNER: "HR",
        TABLE_NAME: "EMPLOYEES",
        DB_LINK: "PROD_LINK",
        DDL: "CREATE SYNONYM EMP_SYN FOR HR.EMPLOYEES@PROD_LINK;",
      }],
    });

    const result = await synonymDetails({ owner: "SCOTT", name: "EMP_SYN" });

    expect(result.detail!.targetDbLink).toBe("PROD_LINK");
  });

  it("returns null detail when synonym not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await synonymDetails({ owner: "SCOTT", name: "MISSING_SYN" });

    expect(result.detail).toBeNull();
  });

  it("passes correct owner and name bind params", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        SYNONYM_NAME: "EMP_SYN",
        OWNER: "SCOTT",
        TABLE_OWNER: "HR",
        TABLE_NAME: "EMPLOYEES",
        DB_LINK: null,
        DDL: "CREATE SYNONYM EMP_SYN FOR HR.EMPLOYEES;",
      }],
    });

    await synonymDetails({ owner: "SCOTT", name: "EMP_SYN" });

    const binds = mockExecute.mock.calls[0][1] as Record<string, string>;
    expect(binds).toMatchObject({ name: "EMP_SYN", owner: "SCOTT" });
  });
});
