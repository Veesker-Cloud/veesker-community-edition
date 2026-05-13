import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { handleSandboxRepublish } from "./republish";
import { saveBuildConfig } from "./build-config-store";

const fixture = {
  sandboxId: "22222222-2222-2222-2222-222222222222",
  connectionId: "conn-1",
  schemaName: "HR",
  primaryTables: [{ name: "EMPLOYEES" }],
  fkWalkDepth: 2,
  piiLevel: 2 as const,
  ttlDays: 7,
  excludedPlsql: [],
  buildConfigVersion: 1 as const,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vsk-rep-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("handleSandboxRepublish", () => {
  it("errors when build config is missing", async () => {
    let caught: unknown;
    await handleSandboxRepublish(
      { sandboxId: "missing-id" },
      {
        buildsDir: dir,
        buildSandbox: () => { throw new Error("should not call"); },
        requestRepublishUrl: () => { throw new Error("should not call"); },
        uploadToR2: () => { throw new Error("should not call"); },
        finalizeRepublish: () => { throw new Error("should not call"); },
        recoverContentKey: () => { throw new Error("should not call"); },
        oracleConfigResolver: () => { throw new Error("should not call"); },
      },
    ).catch((e) => { caught = e; });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/build config missing/i);
  });

  it("end-to-end flow with mocked deps", async () => {
    await saveBuildConfig(dir, { ...fixture });
    const calls: string[] = [];
    const env = {
      buildsDir: dir,
      buildSandbox: async () => { calls.push("build"); return { outPath: join(dir, "out.vsk"), totalRows: 5 }; },
      requestRepublishUrl: async () => { calls.push("request-url"); return { upload_url: "https://fake/upload", blob_key: "sandboxes/x.vsk", expires_in: 900 }; },
      uploadToR2: async () => { calls.push("upload"); return { sha256: "b".repeat(64), size: 9999 }; },
      finalizeRepublish: async () => { calls.push("finalize"); return { ok: true as const }; },
      recoverContentKey: async () => { calls.push("recover-key"); return new Uint8Array(32); },
      oracleConfigResolver: async () => ({ user: "u", password: "p", connectString: "c" }),
    };
    const result = await handleSandboxRepublish({ sandboxId: fixture.sandboxId }, env);
    expect(calls).toEqual([
      "recover-key",
      "build",
      "request-url",
      "upload",
      "finalize",
    ]);
    expect(result.ok).toBe(true);
    expect(result.new_blob_sha256).toBe("b".repeat(64));
    expect(result.bytes).toBe(9999);
  });
});
