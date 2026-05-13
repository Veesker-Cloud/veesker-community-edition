import { describe, it, expect, beforeEach } from "bun:test";
import { DuckDBHost } from "@veesker/engine";
import {
  registerSession,
  getSession,
  hasSession,
  removeSession,
  clearAllSessions,
  listSessions,
} from "./session";

describe("session registry", () => {
  beforeEach(async () => {
    await clearAllSessions();
  });

  it("registers and retrieves a session", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-1", { duckHost: host, tempPath: "/tmp/sb-1.duckdb", openedAt: 1000 });

    expect(hasSession("sb-1")).toBe(true);
    const got = getSession("sb-1");
    expect(got?.tempPath).toBe("/tmp/sb-1.duckdb");
    expect(got?.openedAt).toBe(1000);

    await host.close();
  });

  it("hasSession returns false for unknown id", () => {
    expect(hasSession("nope")).toBe(false);
    expect(getSession("nope")).toBeUndefined();
  });

  it("removeSession deletes from registry without closing host", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-2", { duckHost: host, tempPath: "/tmp/sb-2.duckdb", openedAt: 0 });
    removeSession("sb-2");
    expect(hasSession("sb-2")).toBe(false);
    // Host should still be usable since removeSession doesn't close
    await host.exec(`CREATE TABLE z (x INTEGER)`);
    await host.close();
  });

  it("listSessions returns all current sandbox ids", async () => {
    const h1 = await DuckDBHost.openInMemory();
    const h2 = await DuckDBHost.openInMemory();
    registerSession("a", { duckHost: h1, tempPath: "/tmp/a", openedAt: 1 });
    registerSession("b", { duckHost: h2, tempPath: "/tmp/b", openedAt: 2 });
    expect(listSessions().sort()).toEqual(["a", "b"]);
    await h1.close();
    await h2.close();
  });

  it("clearAllSessions closes hosts and empties registry", async () => {
    const h1 = await DuckDBHost.openInMemory();
    const h2 = await DuckDBHost.openInMemory();
    registerSession("c", { duckHost: h1, tempPath: "/tmp/c", openedAt: 0 });
    registerSession("d", { duckHost: h2, tempPath: "/tmp/d", openedAt: 0 });
    await clearAllSessions();
    expect(listSessions()).toEqual([]);
    // h1, h2 closed by clearAllSessions
  });
});
