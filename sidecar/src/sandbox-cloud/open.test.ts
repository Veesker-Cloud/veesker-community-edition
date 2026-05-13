import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sodiumReady,
  generateKeypair,
  publicKeyFromPrivate,
  sealEnvelope,
  randomKey,
  DuckDBHost,
  writeEncryptedVsk,
  type VskManifest,
  InMemoryKeyStore,
} from "@veesker/engine";
import { writeCacheEntry } from "./cache";
import { openSandbox, _evictResultCache } from "./open";
import { clearAllSessions, getSession, hasSession } from "./session";

let testRoot: string;

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-open-"));
  process.env.VEESKER_APP_DATA_DIR = testRoot;
  await clearAllSessions();
  for (const id of ["sb-open-1", "sb-idem", "no-such", "sb-no-key"]) {
    _evictResultCache(id);
  }
});

afterEach(async () => {
  delete process.env.VEESKER_APP_DATA_DIR;
  await clearAllSessions();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function buildEncryptedVskBytes(
  ownerKp: { privateKey: Uint8Array; publicKey: Uint8Array },
  contentKey: Uint8Array,
): Promise<Uint8Array> {
  const src = await DuckDBHost.openInMemory();
  await src.exec(
    `CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'one'), (2, 'two')`,
  );
  const manifest: VskManifest = {
    builtAt: new Date().toISOString(),
    sourceId: crypto.randomUUID(),
    schemaName: "TEST",
    ttlExpiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    tables: [
      {
        name: "T",
        rowCount: 2,
        columns: [
          { name: "A", type: "INTEGER", nullable: true },
          { name: "B", type: "TEXT", nullable: true },
        ],
      },
    ],
    piiMasks: [],
  };
  const ownerEnvelope = await sealEnvelope(
    contentKey,
    publicKeyFromPrivate(ownerKp.privateKey),
    ownerKp,
  );
  const tmpVsk = join(tmpdir(), `open-test-${crypto.randomUUID()}.vsk`);
  await writeEncryptedVsk(src, tmpVsk, manifest, contentKey, ownerEnvelope);
  await src.close();
  const bytes = await Bun.file(tmpVsk).bytes();
  await Bun.file(tmpVsk).delete();
  return bytes;
}

describe("openSandbox", () => {
  it("loads cached encrypted .vsk into DuckDBHost and returns schema", async () => {
    await sodiumReady();
    const ownerKp = await generateKeypair();
    const memberKp = await generateKeypair();
    const ownerPub = publicKeyFromPrivate(ownerKp.privateKey);
    const memberPub = publicKeyFromPrivate(memberKp.privateKey);
    const contentKey = randomKey();

    const blobBytes = await buildEncryptedVskBytes(ownerKp, contentKey);
    const memberEnvelope = await sealEnvelope(contentKey, memberPub, ownerKp);

    const cacheRoot = join(testRoot, "sandbox-cache");
    await writeCacheEntry(cacheRoot, "sb-open-1", blobBytes, {
      sandbox_id: "sb-open-1",
      name: "test",
      description: null,
      owner_user_id: "owner-1",
      owner_x25519_pubkey_b64: Buffer.from(ownerPub).toString("base64"),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      ttl_days: 7,
      spec_json: null,
      sealed_envelope: {
        sealed_content_key_b64: Buffer.from(memberEnvelope.ciphertext).toString("base64"),
        envelope_nonce_b64: Buffer.from(memberEnvelope.nonce).toString("base64"),
      },
      pulled_at: new Date().toISOString(),
    });

    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(memberKp.privateKey);

    const out = await openSandbox({
      sandboxId: "sb-open-1",
      keystore,
    });

    expect(out.sandbox_id).toBe("sb-open-1");
    expect(out.tables).toEqual(["t"]);
    expect(out.columns.length).toBe(2);
    expect(out.columns[0].table_name).toBe("t");
    expect(out.status).toBe("open");

    expect(hasSession("sb-open-1")).toBe(true);
    const sess = getSession("sb-open-1");
    expect(sess?.tempPath).toContain("sandbox-tmp");
    expect(existsSync(sess!.tempPath)).toBe(true);
  });

  it("is idempotent: second open returns existing session without re-loading", async () => {
    await sodiumReady();
    const ownerKp = await generateKeypair();
    const memberKp = await generateKeypair();
    const contentKey = randomKey();
    const blobBytes = await buildEncryptedVskBytes(ownerKp, contentKey);
    const memberEnvelope = await sealEnvelope(
      contentKey,
      publicKeyFromPrivate(memberKp.privateKey),
      ownerKp,
    );

    const cacheRoot = join(testRoot, "sandbox-cache");
    await writeCacheEntry(cacheRoot, "sb-idem", blobBytes, {
      sandbox_id: "sb-idem",
      name: "x",
      description: null,
      owner_user_id: "o",
      owner_x25519_pubkey_b64: Buffer.from(publicKeyFromPrivate(ownerKp.privateKey)).toString(
        "base64",
      ),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      ttl_days: 7,
      spec_json: null,
      sealed_envelope: {
        sealed_content_key_b64: Buffer.from(memberEnvelope.ciphertext).toString("base64"),
        envelope_nonce_b64: Buffer.from(memberEnvelope.nonce).toString("base64"),
      },
      pulled_at: new Date().toISOString(),
    });

    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(memberKp.privateKey);

    const r1 = await openSandbox({ sandboxId: "sb-idem", keystore });
    const r2 = await openSandbox({ sandboxId: "sb-idem", keystore });
    expect(r2.opened_at).toBe(r1.opened_at);
  });

  it("throws CacheMissingError when sandbox not in cache", async () => {
    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(new Uint8Array(32));
    await expect(openSandbox({ sandboxId: "no-such", keystore })).rejects.toThrow(/not in cache/i);
  });

  it("throws when keystore returns no private key", async () => {
    await sodiumReady();
    const ownerKp = await generateKeypair();
    const memberKp = await generateKeypair();
    const contentKey = randomKey();
    const blobBytes = await buildEncryptedVskBytes(ownerKp, contentKey);
    const memberEnvelope = await sealEnvelope(
      contentKey,
      publicKeyFromPrivate(memberKp.privateKey),
      ownerKp,
    );

    const cacheRoot = join(testRoot, "sandbox-cache");
    await writeCacheEntry(cacheRoot, "sb-no-key", blobBytes, {
      sandbox_id: "sb-no-key",
      name: "x",
      description: null,
      owner_user_id: "o",
      owner_x25519_pubkey_b64: Buffer.from(publicKeyFromPrivate(ownerKp.privateKey)).toString(
        "base64",
      ),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      ttl_days: 7,
      spec_json: null,
      sealed_envelope: {
        sealed_content_key_b64: Buffer.from(memberEnvelope.ciphertext).toString("base64"),
        envelope_nonce_b64: Buffer.from(memberEnvelope.nonce).toString("base64"),
      },
      pulled_at: new Date().toISOString(),
    });

    const emptyKeystore = new InMemoryKeyStore();
    await expect(
      openSandbox({ sandboxId: "sb-no-key", keystore: emptyKeystore }),
    ).rejects.toThrow(/keystore/i);
  });
});
