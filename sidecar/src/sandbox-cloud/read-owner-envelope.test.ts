import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuckDBHost,
  HEADER_SIZE,
  generateKeypair,
  publicKeyFromPrivate,
  randomKey,
  sealEnvelope,
  sodiumReady,
  writeEncryptedVsk,
  writeVsk,
  type Envelope,
  type VskManifest,
} from "@veesker/engine";
import { readOwnerEnvelopeFromVsk } from "./read-owner-envelope";

let testRoot: string;

beforeAll(async () => {
  await sodiumReady();
});

async function buildFixtureVsk(
  outPath: string,
  ownerKp: { privateKey: Uint8Array; publicKey: Uint8Array },
  contentKey: Uint8Array,
): Promise<Envelope> {
  const src = await DuckDBHost.openInMemory();
  await src.exec(
    `CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2)`,
  );
  const manifest: VskManifest = {
    builtAt: new Date().toISOString(),
    sourceId: crypto.randomUUID(),
    schemaName: "TEST",
    ttlExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    tables: [
      {
        name: "T",
        rowCount: 2,
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
  return ownerEnvelope;
}

describe("readOwnerEnvelopeFromVsk", () => {
  it("round-trips the embedded owner envelope", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "veesker-read-env-"));
    try {
      const ownerKp = await generateKeypair();
      const contentKey = randomKey();
      const fixturePath = join(testRoot, "fixture.vsk");
      const written = await buildFixtureVsk(fixturePath, ownerKp, contentKey);

      const read = await readOwnerEnvelopeFromVsk(fixturePath);

      expect(Array.from(read.nonce)).toEqual(Array.from(written.nonce));
      expect(Array.from(read.ciphertext)).toEqual(
        Array.from(written.ciphertext),
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("throws on a file shorter than the header", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "veesker-read-env-"));
    try {
      const tiny = join(testRoot, "tiny.vsk");
      writeFileSync(tiny, Buffer.alloc(HEADER_SIZE - 1));
      await expect(readOwnerEnvelopeFromVsk(tiny)).rejects.toThrow(
        /vsk header truncated/,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("throws when the .vsk has no embedded envelope (plaintext .vsk)", async () => {
    const root = mkdtempSync(join(tmpdir(), "veesker-read-env-"));
    try {
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
      const fixturePath = join(root, "plaintext.vsk");
      await writeVsk(src, fixturePath, manifest);
      await src.close();

      await expect(readOwnerEnvelopeFromVsk(fixturePath)).rejects.toThrow(
        /no embedded owner envelope/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the envelope bytes are not valid JSON", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "veesker-read-env-"));
    try {
      const ownerKp = await generateKeypair();
      const contentKey = randomKey();
      const fixturePath = join(testRoot, "fixture.vsk");
      await buildFixtureVsk(fixturePath, ownerKp, contentKey);

      const fd = await Bun.file(fixturePath).bytes();
      fd[HEADER_SIZE] = 0xff;
      writeFileSync(fixturePath, fd);

      await expect(readOwnerEnvelopeFromVsk(fixturePath)).rejects.toThrow(
        /envelope JSON parse failed/,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
