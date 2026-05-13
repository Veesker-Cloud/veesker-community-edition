import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DuckDBHost } from "@veesker/engine";
import { registerSession, clearAllSessions } from "./session";
import { querySandbox, NotOpenError } from "./query";

beforeEach(async () => { await clearAllSessions(); });
afterEach(async () => { await clearAllSessions(); });

describe("querySandbox", () => {
  it("returns columns + rows for a SELECT", async () => {
    const host = await DuckDBHost.openInMemory();
    await host.exec(`CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'one'), (2, 'two')`);
    registerSession("sb-q1", { duckHost: host, tempPath: "/tmp/sb-q1.vsk", openedAt: 0 });

    const out = await querySandbox({ sandboxId: "sb-q1", sql: "SELECT a, b FROM t ORDER BY a" });

    expect(out.columns.map(c => c.name)).toEqual(["a", "b"]);
    expect(out.rows).toEqual([[1, "one"], [2, "two"]]);
    expect(out.row_count).toBe(2);
    expect(out.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("throws NotOpenError for unknown sandbox", async () => {
    await expect(querySandbox({ sandboxId: "nope", sql: "SELECT 1" })).rejects.toBeInstanceOf(NotOpenError);
  });

  it("serializes concurrent queries on the same sandbox", async () => {
    const host = await DuckDBHost.openInMemory();
    await host.exec(`CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2), (3)`);
    registerSession("sb-ser", { duckHost: host, tempPath: "/tmp/sb-ser.vsk", openedAt: 0 });

    const results = await Promise.all([
      querySandbox({ sandboxId: "sb-ser", sql: "SELECT COUNT(*) AS c FROM t" }),
      querySandbox({ sandboxId: "sb-ser", sql: "SELECT MAX(a) AS m FROM t" }),
      querySandbox({ sandboxId: "sb-ser", sql: "SELECT MIN(a) AS m FROM t" }),
    ]);

    const r0 = results[0].rows[0][0];
    expect(typeof r0 === "bigint" ? Number(r0) : r0).toBe(3);
    expect(results[1].rows[0]).toEqual([3]);
    expect(results[2].rows[0]).toEqual([1]);
  });
});
