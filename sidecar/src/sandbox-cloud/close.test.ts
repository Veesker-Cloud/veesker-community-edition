import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DuckDBHost } from "@veesker/engine";
import { clearAllSessions, registerSession, hasSession } from "./session";
import { closeSandbox } from "./close";

let testRoot: string;

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-close-"));
  await clearAllSessions();
});
afterEach(async () => {
  await clearAllSessions();
  try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
});

describe("closeSandbox", () => {
  it("closes the DuckDBHost, unlinks temp file, removes session", async () => {
    const host = await DuckDBHost.openInMemory();
    const tempPath = join(testRoot, "blob.vsk");
    writeFileSync(tempPath, "x");
    registerSession("sb-c1", { duckHost: host, tempPath, openedAt: 0 });

    const out = await closeSandbox({ sandboxId: "sb-c1" });

    expect(out).toEqual({ sandbox_id: "sb-c1", status: "closed" });
    expect(hasSession("sb-c1")).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
  });

  it("is idempotent on already-closed sandbox", async () => {
    const out = await closeSandbox({ sandboxId: "never-opened" });
    expect(out).toEqual({ sandbox_id: "never-opened", status: "closed" });
  });

  it("does not throw if temp file is already gone", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-c3", { duckHost: host, tempPath: join(testRoot, "missing.vsk"), openedAt: 0 });
    const out = await closeSandbox({ sandboxId: "sb-c3" });
    expect(out.status).toBe("closed");
  });
});
