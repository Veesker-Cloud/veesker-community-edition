import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  saveBuildConfig,
  loadBuildConfig,
  type SandboxBuildConfig,
} from "./build-config-store";

const fixture: SandboxBuildConfig = {
  sandboxId: "11111111-1111-1111-1111-111111111111",
  connectionId: "conn-1",
  schemaName: "HR",
  primaryTables: [{ name: "EMPLOYEES" }],
  fkWalkDepth: 2,
  piiLevel: 2,
  ttlDays: 7,
  excludedPlsql: [],
  buildConfigVersion: 1,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vsk-buildcfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("build-config-store", () => {
  it("save + load round-trips", async () => {
    await saveBuildConfig(dir, fixture);
    const loaded = await loadBuildConfig(dir, fixture.sandboxId);
    expect(loaded).toEqual(fixture);
  });

  it("loadBuildConfig returns null when file missing", async () => {
    const loaded = await loadBuildConfig(dir, "nonexistent-id");
    expect(loaded).toBeNull();
  });

  it("loadBuildConfig throws on unknown buildConfigVersion", async () => {
    const futureFile = { ...fixture, buildConfigVersion: 999 };
    writeFileSync(
      join(dir, `${fixture.sandboxId}.config.json`),
      JSON.stringify(futureFile),
    );
    let caught: unknown;
    await loadBuildConfig(dir, fixture.sandboxId).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/unsupported/i);
  });

  it("saveBuildConfig overwrites existing file", async () => {
    await saveBuildConfig(dir, fixture);
    const updated = { ...fixture, ttlDays: 14 };
    await saveBuildConfig(dir, updated);
    const loaded = await loadBuildConfig(dir, fixture.sandboxId);
    expect(loaded?.ttlDays).toBe(14);
  });
});
