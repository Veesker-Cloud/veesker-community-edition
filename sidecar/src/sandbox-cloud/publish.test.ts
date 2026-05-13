import { describe, it, expect, beforeAll } from "bun:test";
import {
  sodiumReady,
  generateKeypair,
  publicKeyFromPrivate,
  openEnvelope,
  buildAad,
  FORMAT_V2,
  randomKey,
  sealEnvelope,
  writeEncryptedVsk,
  DuckDBHost,
  type VskManifest,
} from "@veesker/engine";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { publishSandbox } from "./publish";

beforeAll(async () => {
  await sodiumReady();
});

async function buildV1Fixture(
  ownerKp: { privateKey: Uint8Array; publicKey: Uint8Array },
  contentKey: Uint8Array,
): Promise<Uint8Array> {
  const src = await DuckDBHost.openInMemory();
  await src.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (42)");
  const manifest: VskManifest = {
    builtAt: new Date().toISOString(),
    sourceId: randomUUID(),
    schemaName: "TEST",
    ttlExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    tables: [{ name: "T", rowCount: 1, columns: [{ name: "A", type: "INTEGER", nullable: true }] }],
    piiMasks: [],
  };
  const ownerEnvelope = await sealEnvelope(contentKey, ownerKp.publicKey, ownerKp);
  const outPath = join(tmpdir(), `publish-test-v1-${randomUUID()}.vsk`);
  try {
    await writeEncryptedVsk(src, outPath, manifest, contentKey, ownerEnvelope);
    return new Uint8Array(readFileSync(outPath));
  } finally {
    await src.close();
    try { unlinkSync(outPath); } catch { /* best effort */ }
  }
}

describe("publishSandbox", () => {
  it("creates, uploads v2 bytes, seals envelopes for owner+member, finalizes", async () => {
    const ownerKp = await generateKeypair();
    const memberKp = await generateKeypair();
    const memberPub = publicKeyFromPrivate(memberKp.privateKey);
    const ownerPub = publicKeyFromPrivate(ownerKp.privateKey);

    const contentKey = randomKey();
    const v1Bytes = await buildV1Fixture(ownerKp, contentKey);

    const sandboxId = "00000000-0000-4000-8000-000000000001";

    let uploadedBytes: Uint8Array | null = null;
    let finalizeBody: any = null;
    let createBody: any = null;

    const apiClient = {
      get: async (path: string) => {
        if (path === `/v1/users/member-1/pubkey`) {
          return {
            user_id: "member-1",
            x25519_pubkey: Buffer.from(memberPub).toString("base64"),
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path: string, body: any) => {
        if (path === "/v1/sandboxes") {
          createBody = body;
          return {
            sandbox_id: sandboxId,
            upload_url: "https://r2.test/put-url?sig=x",
            upload_expires_at: new Date(Date.now() + 900000).toISOString(),
            // x25519_pubkey stripped from response per API-S-008
            recipients: [
              { user_id: "owner-1" },
              { user_id: "member-1" },
            ],
          };
        }
        if (path.endsWith("/finalize")) {
          finalizeBody = body;
          return null;
        }
        throw new Error(`unexpected POST ${path}`);
      },
    } as any;

    const uploader = async (_url: string, bytes: Uint8Array) => {
      uploadedBytes = bytes;
    };

    const result = await publishSandbox({
      apiClient,
      ownerKeypair: ownerKp,
      ownerUserId: "owner-1",
      buildResult: {
        encryptedVsk: v1Bytes,
        contentKey,
        sandboxName: "test",
        ttlDays: 7,
        memberUserIds: ["member-1"],
        specJson: { schemaName: "X", primaryTables: [] },
      },
      uploader,
    });

    expect(result.sandboxId).toBe(sandboxId);
    expect(uploadedBytes).not.toBeNull();
    // Uploaded bytes are the re-encrypted v2 blob — larger than v1
    expect(uploadedBytes!.length).toBeGreaterThan(0);
    // FORMAT_V2 is stored at bytes 6-7 (little-endian uint16) in the header
    const fmtVersion = new DataView(uploadedBytes!.buffer, uploadedBytes!.byteOffset, uploadedBytes!.byteLength).getUint16(6, true);
    expect(fmtVersion).toBe(FORMAT_V2);
    expect(finalizeBody.envelopes).toHaveLength(2);
    expect(finalizeBody.blob_size_bytes).toBe(uploadedBytes!.length);
    expect(finalizeBody.blob_sha256_hex).toMatch(/^[0-9a-f]{64}$/);

    // The shared AAD used to seal all envelopes
    const sharedAad = buildAad({
      sandboxId,
      sandboxVersion: 1,
      recipientPubkey: ownerPub,
      formatVersion: FORMAT_V2,
    });

    // Owner can decrypt their envelope with AAD
    const ownerEnvEntry = finalizeBody.envelopes.find((e: any) => e.user_id === "owner-1");
    const ownerEnvelope = {
      ciphertext: Buffer.from(ownerEnvEntry.sealed_content_key, "base64"),
      nonce: Buffer.from(ownerEnvEntry.envelope_nonce, "base64"),
    };
    const ownerRecoveredKey = await openEnvelope(ownerEnvelope, ownerPub, ownerKp, { aad: sharedAad });
    expect(ownerRecoveredKey.length).toBe(32);

    // Member can decrypt their envelope with the same shared AAD
    const memberEnvEntry = finalizeBody.envelopes.find((e: any) => e.user_id === "member-1");
    const memberEnvelope = {
      ciphertext: Buffer.from(memberEnvEntry.sealed_content_key, "base64"),
      nonce: Buffer.from(memberEnvEntry.envelope_nonce, "base64"),
    };
    const memberRecoveredKey = await openEnvelope(memberEnvelope, ownerPub, memberKp, { aad: sharedAad });
    expect(memberRecoveredKey.length).toBe(32);
  });

  it("propagates a 422 from POST /v1/sandboxes without uploading", async () => {
    const ownerKp = await generateKeypair();
    const apiClient = {
      get: async (path: string) => {
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path: string) => {
        if (path === "/v1/sandboxes") {
          const e: any = new Error("recipients_without_pubkey");
          e.status = 422;
          throw e;
        }
        throw new Error("unexpected");
      },
    } as any;
    let uploaded = false;
    const uploader = async () => { uploaded = true; };

    const contentKey = randomKey();
    const v1Bytes = await buildV1Fixture(ownerKp, contentKey);

    await expect(publishSandbox({
      apiClient,
      ownerKeypair: ownerKp,
      ownerUserId: "owner-1",
      buildResult: {
        encryptedVsk: v1Bytes,
        contentKey,
        sandboxName: "test",
        ttlDays: 7,
        memberUserIds: ["bad-user"],
        specJson: null,
      },
      uploader,
    })).rejects.toThrow();
    expect(uploaded).toBe(false);
  });
});
