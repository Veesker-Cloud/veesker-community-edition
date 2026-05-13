import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCacheEntry,
  readCacheEntry,
  listCacheEntries,
  resolveSandboxCacheDir,
  type SandboxCacheMeta,
  CacheCorruptError,
  CacheMissingError,
} from "./cache";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-cache-"));
});

afterEach(() => {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
});

function makeMeta(id: string): Omit<SandboxCacheMeta, "blob_sha256_hex" | "blob_size_bytes"> {
  return {
    sandbox_id: id,
    name: "test sandbox",
    description: null,
    owner_user_id: "00000000-0000-4000-8000-000000000001",
    owner_x25519_pubkey_b64: Buffer.alloc(32, 1).toString("base64"),
    expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ttl_days: 7,
    spec_json: { schemaName: "X", primaryTables: [] },
    sealed_envelope: {
      sealed_content_key_b64: Buffer.alloc(48, 2).toString("base64"),
      envelope_nonce_b64: Buffer.alloc(12, 3).toString("base64"),
    },
    pulled_at: new Date().toISOString(),
  };
}

describe("cache", () => {
  it("writeCacheEntry creates blob.vsk + meta.json with correct sha256", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const blob = new Uint8Array([0xc0, 0xde, 0xfe, 0xed]);
    const meta = makeMeta(id);

    const written = await writeCacheEntry(testRoot, id, blob, meta);

    expect(written.blob_sha256_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(written.blob_size_bytes).toBe(4);

    const blobPath = join(testRoot, id, "blob.vsk");
    const metaPath = join(testRoot, id, "meta.json");
    expect(readFileSync(blobPath)).toEqual(Buffer.from(blob));
    const persisted = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(persisted.blob_sha256_hex).toBe(written.blob_sha256_hex);
    expect(persisted.blob_size_bytes).toBe(4);
  });

  it("readCacheEntry returns blob + meta and verifies sha256 match", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const meta = makeMeta(id);
    await writeCacheEntry(testRoot, id, blob, meta);

    const got = await readCacheEntry(testRoot, id);

    expect(got.blob).toEqual(blob);
    expect(got.meta.sandbox_id).toBe(id);
    expect(got.meta.blob_sha256_hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("readCacheEntry throws CacheCorruptError on sha256 mismatch", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await writeCacheEntry(testRoot, id, new Uint8Array([1, 2, 3]), makeMeta(id));
    writeFileSync(join(testRoot, id, "blob.vsk"), Buffer.from([9, 9, 9, 9]));

    await expect(readCacheEntry(testRoot, id)).rejects.toBeInstanceOf(CacheCorruptError);
  });

  it("readCacheEntry throws CacheMissingError when entry does not exist", async () => {
    await expect(readCacheEntry(testRoot, "no-such-id")).rejects.toBeInstanceOf(CacheMissingError);
  });

  it("listCacheEntries enumerates all valid cached sandboxes", async () => {
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    for (const id of ids) {
      await writeCacheEntry(testRoot, id, new Uint8Array([0]), makeMeta(id));
    }
    const list = await listCacheEntries(testRoot);
    expect(list.map(e => e.sandbox_id).sort()).toEqual(ids.sort());
  });

  it("listCacheEntries returns empty array when cache dir does not exist", async () => {
    const list = await listCacheEntries(join(testRoot, "nonexistent"));
    expect(list).toEqual([]);
  });

  it("listCacheEntries skips entries with corrupt meta.json", async () => {
    const goodId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const badId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await writeCacheEntry(testRoot, goodId, new Uint8Array([0]), makeMeta(goodId));
    const badDir = join(testRoot, badId);
    require("node:fs").mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "meta.json"), "not valid json");
    writeFileSync(join(badDir, "blob.vsk"), "");

    const list = await listCacheEntries(testRoot);
    expect(list.map(e => e.sandbox_id)).toEqual([goodId]);
  });

  it("resolveSandboxCacheDir uses VEESKER_APP_DATA_DIR when set", () => {
    process.env.VEESKER_APP_DATA_DIR = testRoot;
    try {
      const dir = resolveSandboxCacheDir();
      expect(dir).toBe(join(testRoot, "sandbox-cache"));
    } finally {
      delete process.env.VEESKER_APP_DATA_DIR;
    }
  });
});
