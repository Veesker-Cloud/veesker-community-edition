// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceOpen: vi.fn(),
  workspaceClose: vi.fn(),
  schemaList: vi.fn(),
  objectsList: vi.fn(),
  objectsListPlsql: vi.fn(),
  tableDescribe: vi.fn(),
  objectDdlGet: vi.fn(),
  objectDataflowGet: vi.fn(),
}));

vi.mock("$lib/workspace", () => ({
  workspaceOpen: mocks.workspaceOpen,
  workspaceClose: mocks.workspaceClose,
  schemaList: mocks.schemaList,
  objectsList: mocks.objectsList,
  objectsListPlsql: mocks.objectsListPlsql,
  tableDescribe: mocks.tableDescribe,
  objectDdlGet: mocks.objectDdlGet,
  objectDataflowGet: mocks.objectDataflowGet,
}));

import { OracleWorkspaceSource, ORACLE_CAPABILITIES } from "./oracle";
import type { ConnectionMeta } from "$lib/connections";

const conn: ConnectionMeta = {
  id: "conn-1",
  name: "PROD",
  authType: "basic",
  username: "scott",
  host: "h",
  port: 1521,
  serviceName: "x",
} as ConnectionMeta;

describe("OracleWorkspaceSource", () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));

  it("constructs meta from ConnectionMeta", () => {
    const src = new OracleWorkspaceSource(conn);
    expect(src.meta.id).toBe("conn-1");
    expect(src.meta.kind).toBe("oracle");
    expect(src.meta.displayName).toBe("PROD");
    expect(src.meta.subtitle).toContain("scott @ h");
    expect(src.meta.role).toBeUndefined();
    expect(src.capabilities).toBe(ORACLE_CAPABILITIES);
  });

  it("open() calls workspaceOpen with the connection id", async () => {
    mocks.workspaceOpen.mockResolvedValue({ ok: true, data: { serverVersion: "23ai", currentSchema: "SCOTT", user: "SCOTT", serviceName: "ORCL" } });
    const src = new OracleWorkspaceSource(conn);
    await src.open();
    expect(mocks.workspaceOpen).toHaveBeenCalledWith("conn-1");
  });

  it("listObjects routes PROCEDURE to objectsListPlsql, TABLE to objectsList", async () => {
    mocks.objectsList.mockResolvedValue({ ok: true, data: [{ name: "EMP" }] });
    mocks.objectsListPlsql.mockResolvedValue({ ok: true, data: [{ name: "P1", status: "VALID" }] });
    const src = new OracleWorkspaceSource(conn);
    expect(await src.listObjects("HR", "TABLE")).toEqual([{ name: "EMP" }]);
    expect(await src.listObjects("HR", "PROCEDURE")).toEqual([{ name: "P1", status: "VALID" }]);
    expect(mocks.objectsList).toHaveBeenCalledWith("HR", "TABLE");
    expect(mocks.objectsListPlsql).toHaveBeenCalledWith("HR", "PROCEDURE");
  });

  it("loadDdl returns {kind:'ok'} on success, {kind:'error'} on failure", async () => {
    mocks.objectDdlGet.mockResolvedValueOnce({ ok: true, data: { ddl: "CREATE TABLE EMP..." } });
    const src = new OracleWorkspaceSource(conn);
    const r = await src.loadDdl("HR", "EMP", "TABLE");
    expect(r).toEqual({ kind: "ok", ddl: "CREATE TABLE EMP...", spec: undefined, body: undefined });

    mocks.objectDdlGet.mockResolvedValueOnce({ ok: false, error: { code: -32013, message: "ORA-00942" } });
    const r2 = await src.loadDdl("HR", "MISSING", "TABLE");
    expect(r2).toEqual({ kind: "error", error: "ORA-00942", code: -32013 });
  });

  it("loadDdl forwards spec/body for PACKAGE results", async () => {
    mocks.objectDdlGet.mockResolvedValueOnce({
      ok: true,
      data: { ddl: "CREATE PACKAGE PKG...", spec: "SPEC SQL", body: "BODY SQL" },
    });
    const src = new OracleWorkspaceSource(conn);
    const r = await src.loadDdl("HR", "PKG", "PACKAGE");
    expect(r).toEqual({ kind: "ok", ddl: "CREATE PACKAGE PKG...", spec: "SPEC SQL", body: "BODY SQL" });
  });

  it("listSchemas wraps Schema[] into SchemaNode[] (kinds: idle for all)", async () => {
    mocks.schemaList.mockResolvedValue({
      ok: true,
      data: [{ name: "HR", isCurrent: true }, { name: "SCOTT", isCurrent: false }],
    });
    const src = new OracleWorkspaceSource(conn);
    const nodes = await src.listSchemas();
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe("HR");
    expect(nodes[0].isCurrent).toBe(true);
    expect(nodes[0].kinds.TABLE.kind).toBe("idle");
    expect(nodes[0].kinds.VIEW.kind).toBe("idle");
  });

  it("loadDataflow forwards the kind argument to the RPC", async () => {
    mocks.objectDataflowGet.mockResolvedValueOnce({ ok: true, data: { nodes: [], edges: [] } as any });
    const src = new OracleWorkspaceSource(conn);
    await src.loadDataflow("HR", "GET_EMP", "PROCEDURE");
    expect(mocks.objectDataflowGet).toHaveBeenCalledWith("HR", "PROCEDURE", "GET_EMP");
  });

  it("close() calls workspaceClose with no args", async () => {
    mocks.workspaceClose.mockResolvedValue({ ok: true });
    const src = new OracleWorkspaceSource(conn);
    await src.close();
    expect(mocks.workspaceClose).toHaveBeenCalled();
  });

  it("runQuery throws — Oracle queries flow through sqlEditor, not the source", async () => {
    const src = new OracleWorkspaceSource(conn);
    await expect(src.runQuery("SELECT 1")).rejects.toThrow(
      "OracleWorkspaceSource.runQuery: use sqlEditor for Oracle queries",
    );
  });

  it("subtitle uses connectAlias for wallet auth", () => {
    const walletConn = {
      id: "conn-2",
      name: "PROD-WALLET",
      authType: "wallet",
      username: "scott",
      connectAlias: "MYDB",
    } as ConnectionMeta;
    const src = new OracleWorkspaceSource(walletConn);
    expect(src.meta.subtitle).toBe("scott @ MYDB");
  });
});
