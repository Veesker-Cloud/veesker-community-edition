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

mock.module("./state", () => ({
  getActiveSession: () => mockConn,
}));

import { objectsList } from "./oracle";

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
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
