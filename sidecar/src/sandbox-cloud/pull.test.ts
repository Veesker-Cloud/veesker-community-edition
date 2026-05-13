import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sodiumReady, generateKeypair, publicKeyFromPrivate, sealEnvelope, randomKey, encryptBlob } from "@veesker/engine";
import { pullSandbox } from "./pull";
import { resolveSandboxCacheDir } from "./cache";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-pull-"));
  process.env.VEESKER_APP_DATA_DIR = testRoot;
});

afterEach(() => {
  delete process.env.VEESKER_APP_DATA_DIR;
  try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}

describe("pullSandbox (Plan 4 — writes to cache, no bytes returned)", () => {
  it("downloads blob, fetches owner pubkey, writes cache, returns metadata", async () => {
    await sodiumReady();
    const ownerKp = await generateKeypair();
    const memberKp = await generateKeypair();
    const ownerPub = publicKeyFromPrivate(ownerKp.privateKey);
    const memberPub = publicKeyFromPrivate(memberKp.privateKey);
    const contentKey = await randomKey();
    const memberEnvelope = await sealEnvelope(contentKey, memberPub, ownerKp);

    // Fake encrypted blob — content doesn't matter for pull-time logic
    const blobPlain = new TextEncoder().encode("vsk-fake");
    const encrypted = await encryptBlob(contentKey, blobPlain);
    const blobBytes = encrypted.ciphertext;
    const expectedSha = await sha256Hex(blobBytes);

    const apiClient = {
      get: async (path: string) => {
        if (path === "/v1/sandboxes/sb-1") {
          return {
            sandbox: {
              id: "sb-1",
              owner_user_id: "owner-user-1",
              name: "test-sandbox",
              description: "desc",
              status: "ready",
              blob_sha256_hex: expectedSha,
              blob_size_bytes: blobBytes.byteLength,
              expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
              ttl_days: 7,
              spec_json: { schemaName: "S", primaryTables: ["T"] },
            },
            download_url: "https://r2/blob",
            download_expires_at: new Date(Date.now() + 300_000).toISOString(),
            sealed_envelope: {
              sealed_content_key: Buffer.from(memberEnvelope.ciphertext).toString("base64"),
              envelope_nonce: Buffer.from(memberEnvelope.nonce).toString("base64"),
            },
          };
        }
        if (path === "/v1/users/owner-user-1/pubkey") {
          return { user_id: "owner-user-1", x25519_pubkey: Buffer.from(ownerPub).toString("base64") };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    } as any;

    const downloader = async (_url: string) => blobBytes;

    const result = await pullSandbox({
      apiClient,
      sandboxId: "sb-1",
      downloader,
    });

    expect(result.sandbox_id).toBe("sb-1");
    expect(result.name).toBe("test-sandbox");
    expect(result.status).toBe("ready");
    expect(result.blob_size_bytes).toBe(blobBytes.byteLength);
    expect(result.cached).toBe(true);
    expect(result.pulled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify cache contents
    const cacheDir = resolveSandboxCacheDir();
    expect(existsSync(join(cacheDir, "sb-1", "blob.vsk"))).toBe(true);
    expect(existsSync(join(cacheDir, "sb-1", "meta.json"))).toBe(true);

    const meta = JSON.parse(readFileSync(join(cacheDir, "sb-1", "meta.json"), "utf-8"));
    expect(meta.owner_user_id).toBe("owner-user-1");
    expect(meta.owner_x25519_pubkey_b64).toBe(Buffer.from(ownerPub).toString("base64"));
    expect(meta.blob_sha256_hex).toBe(expectedSha);
    expect(meta.sealed_envelope.sealed_content_key_b64).toBe(Buffer.from(memberEnvelope.ciphertext).toString("base64"));
    expect(meta.sealed_envelope.envelope_nonce_b64).toBe(Buffer.from(memberEnvelope.nonce).toString("base64"));
  });

  it("throws when sha256 mismatch detected after download", async () => {
    const memberEnvelope = { ciphertext: new Uint8Array(48), nonce: new Uint8Array(12) };
    const apiClient = {
      get: async (path: string) => {
        if (path === "/v1/sandboxes/sb-bad") {
          return {
            sandbox: { id: "sb-bad", owner_user_id: "u", name: "bad", description: null, status: "ready",
              blob_sha256_hex: "0".repeat(64), blob_size_bytes: 4,
              expires_at: new Date().toISOString(), ttl_days: 7, spec_json: null },
            download_url: "https://r2/x",
            download_expires_at: new Date().toISOString(),
            sealed_envelope: {
              sealed_content_key: Buffer.from(memberEnvelope.ciphertext).toString("base64"),
              envelope_nonce: Buffer.from(memberEnvelope.nonce).toString("base64"),
            },
          };
        }
        if (path === "/v1/users/u/pubkey") {
          return { user_id: "u", x25519_pubkey: Buffer.alloc(32, 9).toString("base64") };
        }
        throw new Error("unexpected");
      },
    } as any;
    const downloader = async () => new Uint8Array([1, 2, 3]); // sha will not match "0"x64
    await expect(pullSandbox({ apiClient, sandboxId: "sb-bad", downloader })).rejects.toThrow(/sha256/i);
  });
});
