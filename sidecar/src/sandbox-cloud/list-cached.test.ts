import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCacheEntry } from "./cache";
import { listCachedSandboxes } from "./list-cached";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-list-"));
  process.env.VEESKER_APP_DATA_DIR = testRoot;
});
afterEach(() => {
  delete process.env.VEESKER_APP_DATA_DIR;
  try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
});

function metaFor(id: string) {
  return {
    sandbox_id: id,
    name: `name-${id}`,
    description: null,
    owner_user_id: "owner",
    owner_x25519_pubkey_b64: Buffer.alloc(32, 1).toString("base64"),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    ttl_days: 7,
    spec_json: null,
    sealed_envelope: {
      sealed_content_key_b64: Buffer.alloc(48, 2).toString("base64"),
      envelope_nonce_b64: Buffer.alloc(12, 3).toString("base64"),
    },
    pulled_at: new Date().toISOString(),
  };
}

describe("listCachedSandboxes", () => {
  it("returns empty list when cache dir does not exist", async () => {
    const out = await listCachedSandboxes();
    expect(out).toEqual({ sandboxes: [] });
  });

  it("returns metadata for each cached sandbox", async () => {
    const cacheRoot = join(testRoot, "sandbox-cache");
    await writeCacheEntry(cacheRoot, "sb-list-1", new Uint8Array([1, 2, 3]), metaFor("sb-list-1"));
    await writeCacheEntry(cacheRoot, "sb-list-2", new Uint8Array([4, 5, 6, 7]), metaFor("sb-list-2"));

    const out = await listCachedSandboxes();

    expect(out.sandboxes.map(s => s.sandbox_id).sort()).toEqual(["sb-list-1", "sb-list-2"]);
    expect(out.sandboxes.find(s => s.sandbox_id === "sb-list-1")?.blob_size_bytes).toBe(3);
    expect(out.sandboxes.find(s => s.sandbox_id === "sb-list-2")?.blob_size_bytes).toBe(4);
  });
});
