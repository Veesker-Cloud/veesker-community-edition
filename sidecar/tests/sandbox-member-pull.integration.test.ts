import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { writeCacheEntry } from "../src/sandbox-cloud/cache";
import { openSandbox } from "../src/sandbox-cloud/open";
import { querySandbox } from "../src/sandbox-cloud/query";
import { closeSandbox } from "../src/sandbox-cloud/close";
import { listCachedSandboxes } from "../src/sandbox-cloud/list-cached";
import { clearAllSessions, hasSession } from "../src/sandbox-cloud/session";

let testRoot: string;

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-int-"));
  process.env.VEESKER_APP_DATA_DIR = testRoot;
  await clearAllSessions();
});
afterEach(async () => {
  delete process.env.VEESKER_APP_DATA_DIR;
  await clearAllSessions();
  try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
});

describe("Plan 4 integration: open -> query -> close round-trip", () => {
  it("end-to-end: cached encrypted .vsk -> DuckDB queries -> close", async () => {
    await sodiumReady();

    const ownerKp = await generateKeypair();
    const memberKp = await generateKeypair();
    const ownerPub = publicKeyFromPrivate(ownerKp.privateKey);
    const contentKey = randomKey();

    const src = await DuckDBHost.openInMemory();
    await src.exec(`
      CREATE TABLE customers (id INTEGER, name TEXT, country TEXT);
      INSERT INTO customers VALUES (1, 'Alice', 'BR'), (2, 'Bob', 'US'), (3, 'Carol', 'BR');
      CREATE TABLE orders (id INTEGER, customer_id INTEGER, total DOUBLE);
      INSERT INTO orders VALUES (10, 1, 100.5), (11, 1, 200.0), (12, 2, 50.0);
    `);
    const manifest: VskManifest = {
      builtAt: new Date().toISOString(),
      sourceId: "demo-source",
      schemaName: "DEMO",
      ttlExpiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      tables: [
        {
          name: "CUSTOMERS",
          rowCount: 3,
          columns: [
            { name: "ID", type: "INTEGER", nullable: true },
            { name: "NAME", type: "TEXT", nullable: true },
            { name: "COUNTRY", type: "TEXT", nullable: true },
          ],
        },
        {
          name: "ORDERS",
          rowCount: 3,
          columns: [
            { name: "ID", type: "INTEGER", nullable: true },
            { name: "CUSTOMER_ID", type: "INTEGER", nullable: true },
            { name: "TOTAL", type: "DOUBLE", nullable: true },
          ],
        },
      ],
      piiMasks: [],
    };
    const ownerEnvelope = await sealEnvelope(contentKey, ownerPub, ownerKp);
    const tmpVsk = join(testRoot, "build.vsk");
    await writeEncryptedVsk(src, tmpVsk, manifest, contentKey, ownerEnvelope);
    await src.close();
    const blobBytes = await Bun.file(tmpVsk).bytes();

    const memberEnvelope = await sealEnvelope(contentKey, publicKeyFromPrivate(memberKp.privateKey), ownerKp);
    const cacheRoot = join(testRoot, "sandbox-cache");
    await writeCacheEntry(cacheRoot, "sb-int-1", blobBytes, {
      sandbox_id: "sb-int-1",
      name: "demo",
      description: null,
      owner_user_id: "owner-1",
      owner_x25519_pubkey_b64: Buffer.from(ownerPub).toString("base64"),
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      ttl_days: 7,
      spec_json: { schemaName: "DEMO", primaryTables: ["CUSTOMERS", "ORDERS"] },
      sealed_envelope: {
        sealed_content_key_b64: Buffer.from(memberEnvelope.ciphertext).toString("base64"),
        envelope_nonce_b64: Buffer.from(memberEnvelope.nonce).toString("base64"),
      },
      pulled_at: new Date().toISOString(),
    });

    const list = await listCachedSandboxes();
    expect(list.sandboxes.map(s => s.sandbox_id)).toEqual(["sb-int-1"]);

    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(memberKp.privateKey);
    const opened = await openSandbox({ sandboxId: "sb-int-1", keystore });
    expect(opened.tables.sort()).toEqual(["customers", "orders"]);
    expect(opened.columns.length).toBe(6);
    expect(hasSession("sb-int-1")).toBe(true);

    const q1 = await querySandbox({ sandboxId: "sb-int-1", sql: "SELECT COUNT(*) AS c FROM customers" });
    expect(q1.row_count).toBe(1);
    expect(q1.columns[0].name).toBe("c");

    const q2 = await querySandbox({
      sandboxId: "sb-int-1",
      sql: `
        SELECT c.country, SUM(o.total) AS total
        FROM customers c JOIN orders o ON o.customer_id = c.id
        GROUP BY c.country
        ORDER BY c.country
      `,
    });
    expect(q2.rows.length).toBe(2);
    const byCountry = Object.fromEntries(q2.rows.map((r: any) => [String(r[0]), Number(r[1])]));
    expect(byCountry.BR).toBeCloseTo(300.5, 1);
    expect(byCountry.US).toBeCloseTo(50.0, 1);

    const closed = await closeSandbox({ sandboxId: "sb-int-1" });
    expect(closed.status).toBe("closed");
    expect(hasSession("sb-int-1")).toBe(false);

    const list2 = await listCachedSandboxes();
    expect(list2.sandboxes.map(s => s.sandbox_id)).toEqual(["sb-int-1"]);
  });
});
