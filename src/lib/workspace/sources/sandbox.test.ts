// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  openSandbox: vi.fn(),
  closeSandbox: vi.fn(),
  querySandbox: vi.fn(),
}));

vi.mock("$lib/sandbox", () => ({
  openSandbox: mocks.openSandbox,
  closeSandbox: mocks.closeSandbox,
  querySandbox: mocks.querySandbox,
}));

import { SandboxWorkspaceSource, SANDBOX_CAPABILITIES_V1, formatExpiresIn } from "./sandbox";
import type { SandboxSummary } from "$lib/sandbox";

const sb: SandboxSummary = {
  sandbox_id: "sb-1",
  name: "Q3 finance slice",
  owner_user_id: "u-owner",
  blob_size_bytes: 12345,
  expires_at: "2026-12-31T00:00:00Z",
  status: "ready",
  cached: true,
  role: "member",
} as SandboxSummary;

describe("SandboxWorkspaceSource", () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));

  it("constructs meta from SandboxSummary", () => {
    const src = new SandboxWorkspaceSource(sb);
    expect(src.meta.id).toBe("sb-1");
    expect(src.meta.kind).toBe("sandbox");
    expect(src.meta.displayName).toBe("Q3 finance slice");
    expect(src.meta.role).toBe("member");
    expect(src.meta.expiresAt).toBe("2026-12-31T00:00:00Z");
    expect(src.meta.subtitle).toMatch(/expires/);
  });

  it("capabilities only include TABLE for v1", () => {
    expect(SANDBOX_CAPABILITIES_V1.kinds.has("TABLE")).toBe(true);
    expect(SANDBOX_CAPABILITIES_V1.kinds.has("PROCEDURE")).toBe(false);
    expect(SANDBOX_CAPABILITIES_V1.kinds.has("PACKAGE")).toBe(false);
    expect(SANDBOX_CAPABILITIES_V1.tabs).toEqual(["schema"]);
  });

  it("open() calls openSandbox and caches result", async () => {
    mocks.openSandbox.mockResolvedValue({
      sandbox_id: "sb-1",
      tables: ["EMP", "DEPT"],
      columns: [
        { table_name: "EMP", name: "ID", type: "INTEGER", nullable: false },
      ],
      opened_at: "2026-05-03T10:00:00Z",
      status: "open",
    });
    const src = new SandboxWorkspaceSource(sb);
    const r = await src.open();
    expect(r.ok).toBe(true);
    expect(mocks.openSandbox).toHaveBeenCalledWith("sb-1");
  });

  it("listObjects returns tables for TABLE, [] for other kinds", async () => {
    mocks.openSandbox.mockResolvedValue({
      sandbox_id: "sb-1",
      tables: ["EMP", "DEPT"],
      columns: [],
      opened_at: "x",
      status: "open",
    });
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    expect(await src.listObjects("any", "TABLE")).toEqual([
      { name: "EMP" },
      { name: "DEPT" },
    ]);
    expect(await src.listObjects("any", "PROCEDURE")).toEqual([]);
    expect(await src.listObjects("any", "PACKAGE")).toEqual([]);
  });

  it("describeTable filters columns by table_name from cached open()", async () => {
    mocks.openSandbox.mockResolvedValue({
      sandbox_id: "sb-1",
      tables: ["EMP"],
      columns: [
        { table_name: "EMP", name: "ID", type: "INTEGER", nullable: false },
        { table_name: "EMP", name: "NAME", type: "VARCHAR", nullable: true },
        { table_name: "DEPT", name: "ID", type: "INTEGER", nullable: false },
      ],
      opened_at: "x",
      status: "open",
    });
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    const td = await src.describeTable("any", "EMP");
    expect(td.columns).toHaveLength(2);
    expect(td.columns.map((c) => c.name).sort()).toEqual(["ID", "NAME"]);
  });

  it("runQuery delegates to querySandbox with id + sql", async () => {
    mocks.querySandbox.mockResolvedValue({
      columns: [{ name: "X", type: "INTEGER" }],
      rows: [[1]],
      row_count: 1,
      elapsed_ms: 5,
    });
    const src = new SandboxWorkspaceSource(sb);
    await src.runQuery("SELECT 1 AS X");
    expect(mocks.querySandbox).toHaveBeenCalledWith("sb-1", "SELECT 1 AS X");
  });

  it("loadDdl + loadDataflow return {kind:'unsupported'}", async () => {
    const src = new SandboxWorkspaceSource(sb);
    expect(await src.loadDdl("any", "EMP", "TABLE")).toEqual({ kind: "unsupported" });
    expect(await src.loadDataflow("any", "EMP", "TABLE")).toEqual({ kind: "unsupported" });
  });

  it("open() returns {ok:false,error} when openSandbox throws", async () => {
    mocks.openSandbox.mockRejectedValue(new Error("blob 404"));
    const src = new SandboxWorkspaceSource(sb);
    const r = await src.open();
    expect(r).toEqual({ ok: false, error: "blob 404" });
  });

  it("open() handles non-Error throws via String() fallback", async () => {
    mocks.openSandbox.mockRejectedValue("network down");
    const src = new SandboxWorkspaceSource(sb);
    const r = await src.open();
    expect(r).toEqual({ ok: false, error: "network down" });
  });
});

describe("SandboxWorkspaceSource v0.2.0 detection", () => {
  it("uses V2 capabilities when __vsk_objects exists", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["users"], columns: [] });
    mocks.querySandbox.mockResolvedValueOnce({ rows: [[1]], columns: ["one"] }); // __vsk_objects exists
    const src = new SandboxWorkspaceSource(sb);
    const r = await src.open();
    expect(r.ok).toBe(true);
    expect(src.capabilities.kinds.has("PROCEDURE")).toBe(true);
    expect(src.capabilities.kinds.has("PACKAGE")).toBe(true);
    expect(src.capabilities.kinds.has("VIEW")).toBe(true);
  });

  it("stays on V1 capabilities when __vsk_objects is missing", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["users"], columns: [] });
    mocks.querySandbox.mockResolvedValueOnce({ rows: [], columns: ["one"] }); // no __vsk_objects
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    expect(src.capabilities.kinds.size).toBe(1);
    expect(src.capabilities.kinds.has("TABLE")).toBe(true);
  });

  it("treats query failure as V1 (degraded gracefully)", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["users"], columns: [] });
    mocks.querySandbox.mockRejectedValueOnce(new Error("information_schema unavailable"));
    const src = new SandboxWorkspaceSource(sb);
    const r = await src.open();
    expect(r.ok).toBe(true);
    expect(src.capabilities.kinds.size).toBe(1);
  });
});

describe("SandboxWorkspaceSource v0.2.0 listObjects + loadDdl", () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));

  it("listObjects returns rows from __vsk_objects when V2", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["u"], columns: [] });
    mocks.querySandbox
      .mockResolvedValueOnce({ rows: [[1]], columns: ["one"] }) // open() detection
      .mockResolvedValueOnce({ rows: [["GET_EMP"], ["UPDATE_SALARY"]], columns: ["name"] });
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    const objs = await src.listObjects("HR", "PROCEDURE");
    expect(objs).toEqual([{ name: "GET_EMP" }, { name: "UPDATE_SALARY" }]);
  });

  it("loadDdl returns DDL from __vsk_source for non-PACKAGE", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["u"], columns: [] });
    mocks.querySandbox
      .mockResolvedValueOnce({ rows: [[1]], columns: ["one"] })
      .mockResolvedValueOnce({ rows: [["CREATE PROCEDURE GET_EMP AS BEGIN NULL; END;", null, null]], columns: ["ddl", "spec", "body"] });
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    const r = await src.loadDdl("HR", "GET_EMP", "PROCEDURE");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.ddl).toContain("GET_EMP");
      expect(r.spec).toBeUndefined();
      expect(r.body).toBeUndefined();
    }
  });

  it("loadDdl returns spec + body for PACKAGE", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["u"], columns: [] });
    mocks.querySandbox
      .mockResolvedValueOnce({ rows: [[1]], columns: ["one"] })
      .mockResolvedValueOnce({ rows: [["", "CREATE PACKAGE PK AS ... END;", "CREATE PACKAGE BODY PK AS ... END;"]], columns: ["ddl", "spec", "body"] });
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    const r = await src.loadDdl("HR", "PK", "PACKAGE");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.spec).toContain("PACKAGE PK");
      expect(r.body).toContain("PACKAGE BODY PK");
    }
  });

  it("loadDdl returns 'unsupported' on V1 sandbox", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["u"], columns: [] });
    mocks.querySandbox.mockResolvedValueOnce({ rows: [], columns: ["one"] }); // V1
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    const r = await src.loadDdl("HR", "X", "PROCEDURE");
    expect(r.kind).toBe("unsupported");
  });

  it("loadDdl returns 'error' when name is missing in __vsk_source", async () => {
    mocks.openSandbox.mockResolvedValueOnce({ tables: ["u"], columns: [] });
    mocks.querySandbox
      .mockResolvedValueOnce({ rows: [[1]], columns: ["one"] })
      .mockResolvedValueOnce({ rows: [], columns: ["ddl", "spec", "body"] });
    const src = new SandboxWorkspaceSource(sb);
    await src.open();
    const r = await src.loadDdl("HR", "GHOST", "PROCEDURE");
    expect(r.kind).toBe("error");
  });
});

describe("formatExpiresIn", () => {
  it("returns 'expired' when ms is negative", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(formatExpiresIn(past)).toBe("expired");
  });

  it("returns 'expires in 1h' for sub-hour clamp", () => {
    const inMinutes = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(formatExpiresIn(inMinutes)).toBe("expires in 1h");
  });

  it("returns 'expires in Xh' below 24h", () => {
    const inHours = new Date(Date.now() + 5 * 3_600_000).toISOString();
    expect(formatExpiresIn(inHours)).toBe("expires in 5h");
  });

  it("returns 'expires in 1d' at exactly 24h", () => {
    const oneDay = new Date(Date.now() + 24 * 3_600_000).toISOString();
    expect(formatExpiresIn(oneDay)).toBe("expires in 1d");
  });

  it("returns 'expires in Nd' for multi-day", () => {
    const inDays = new Date(Date.now() + 7 * 86_400_000 + 1000).toISOString();
    expect(formatExpiresIn(inDays)).toBe("expires in 7d");
  });
});
