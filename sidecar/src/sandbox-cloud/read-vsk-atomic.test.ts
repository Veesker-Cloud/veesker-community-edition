import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuckDBHost,
  generateKeypair,
  publicKeyFromPrivate,
  randomKey,
  sealEnvelope,
  sodiumReady,
  writeEncryptedVsk,
  type VskManifest,
} from "@veesker/engine";
import { readVskAtomic } from "./read-vsk-atomic";

let testRoot: string;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-read-atomic-"));
});

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function buildFixture(outPath: string) {
  const ownerKp = await generateKeypair();
  const contentKey = randomKey();
  const src = await DuckDBHost.openInMemory();
  await src.exec(`CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)`);
  const manifest: VskManifest = {
    builtAt: new Date().toISOString(),
    sourceId: crypto.randomUUID(),
    schemaName: "TEST",
    ttlExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    tables: [
      {
        name: "T",
        rowCount: 1,
        columns: [{ name: "A", type: "INTEGER", nullable: true }],
      },
    ],
    piiMasks: [],
  };
  const ownerEnvelope = await sealEnvelope(
    contentKey,
    publicKeyFromPrivate(ownerKp.privateKey),
    ownerKp,
  );
  await writeEncryptedVsk(src, outPath, manifest, contentKey, ownerEnvelope);
  await src.close();
  return { ownerKp, contentKey };
}

describe("readVskAtomic", () => {
  it("returns envelope and file bytes from a real .vsk", async () => {
    const path = join(testRoot, "ok.vsk");
    await buildFixture(path);

    const { envelope, fileBytes } = await readVskAtomic(path);

    expect(envelope.nonce).toBeInstanceOf(Uint8Array);
    expect(envelope.ciphertext).toBeInstanceOf(Uint8Array);
    expect(envelope.nonce.byteLength).toBeGreaterThan(0);
    expect(envelope.ciphertext.byteLength).toBeGreaterThan(0);
    expect(fileBytes).toBeInstanceOf(Uint8Array);
    expect(fileBytes.byteLength).toBeGreaterThan(64);
  });

  it("rejects a non-existent file", async () => {
    await expect(readVskAtomic(join(testRoot, "missing.vsk"))).rejects.toThrow();
  });

  it("rejects a directory passed as path (fstat catches it)", async () => {
    await expect(readVskAtomic(testRoot)).rejects.toThrow(
      /not a regular file/i,
    );
  });

  it("rejects a file too small to contain a header", async () => {
    const path = join(testRoot, "tiny.vsk");
    writeFileSync(path, Buffer.from("short"));
    await expect(readVskAtomic(path)).rejects.toThrow(/file too small/i);
  });

  it("rejects a file with bad magic", async () => {
    const path = join(testRoot, "badmagic.vsk");
    writeFileSync(path, Buffer.alloc(128, 0x00));
    await expect(readVskAtomic(path)).rejects.toThrow(/bad magic/i);
  });

  it("rejects a plaintext .vsk (envelopeLength=0)", async () => {
    const path = join(testRoot, "plain.vsk");
    const buf = Buffer.alloc(128);
    // VSK_MAGIC = 0x56534b21, big-endian
    buf.writeUInt32BE(0x56534b21, 0);
    buf.writeUInt16LE(1, 4);
    // envelopeLength stays 0 (already zeroed)
    writeFileSync(path, buf);
    await expect(readVskAtomic(path)).rejects.toThrow(
      /no embedded owner envelope/i,
    );
  });

  it("rejects when envelope region extends past file size", async () => {
    const path = join(testRoot, "trunc.vsk");
    const buf = Buffer.alloc(128, 0x00);
    buf.writeUInt32BE(0x56534b21, 0);
    buf.writeUInt16LE(1, 4);
    // envelopeOffset = 100, envelopeLength = 1000 -> overruns 128-byte file
    buf.writeBigUInt64LE(100n, 40);
    buf.writeBigUInt64LE(1000n, 48);
    writeFileSync(path, buf);
    await expect(readVskAtomic(path)).rejects.toThrow(/extends past file/i);
  });
});
