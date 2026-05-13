import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import {
  DuckDBHost,
  publicKeyFromPrivate,
  pubkeyFromBase64,
  sodiumReady,
  type Envelope,
  type Keypair,
  type KeyStore,
  readEncryptedVsk,
} from "@veesker/engine";
import { readCacheEntry, resolveSandboxCacheDir, resolveSandboxTmpDir } from "./cache";
import { hasSession, registerSession } from "./session";

export interface OpenSandboxColumn {
  table_name: string;
  name: string;
  type: string;
  nullable: boolean;
}

export interface OpenSandboxSkippedObject {
  kind: string;
  owner: string;
  name: string;
  reason: string;
  detail?: string;
}

export interface OpenSandboxResult {
  sandbox_id: string;
  tables: string[];
  columns: OpenSandboxColumn[];
  opened_at: string;
  status: "open";
  /** PL/SQL objects skipped during build (v0.2.0+ sandboxes only). Undefined
   *  for v0.1.0 sandboxes. The frontend's StatusBar surfaces a warning when
   *  this is non-empty. */
  skippedObjects?: OpenSandboxSkippedObject[];
}

export interface OpenSandboxParams {
  sandboxId: string;
  keystore: KeyStore;
}

const SESSION_RESULT_CACHE = new Map<string, OpenSandboxResult>();

export async function openSandbox(params: OpenSandboxParams): Promise<OpenSandboxResult> {
  if (hasSession(params.sandboxId)) {
    const cached = SESSION_RESULT_CACHE.get(params.sandboxId);
    if (cached) return cached;
  }

  await sodiumReady();
  const cacheRoot = resolveSandboxCacheDir();
  const { meta } = await readCacheEntry(cacheRoot, params.sandboxId);

  const memberPriv = await params.keystore.getPrivateKey();
  if (!memberPriv) {
    throw new Error("keystore: no private key registered for current member");
  }
  const memberKp: Keypair = {
    privateKey: memberPriv,
    publicKey: publicKeyFromPrivate(memberPriv),
  };
  const ownerPub = pubkeyFromBase64(meta.owner_x25519_pubkey_b64);
  const memberEnvelope: Envelope = {
    ciphertext: new Uint8Array(
      Buffer.from(meta.sealed_envelope.sealed_content_key_b64, "base64"),
    ),
    nonce: new Uint8Array(Buffer.from(meta.sealed_envelope.envelope_nonce_b64, "base64")),
  };

  const blobCachePath = join(cacheRoot, params.sandboxId, "blob.vsk");
  const tmpRoot = resolveSandboxTmpDir();
  mkdirSync(tmpRoot, { recursive: true });
  if (platform() !== "win32") {
    try {
      chmodSync(tmpRoot, 0o700);
    } catch {
      /* best effort */
    }
  }
  const blobTmpPath = join(tmpRoot, `${params.sandboxId}.vsk`);
  const cachedBlob = await Bun.file(blobCachePath).bytes();
  writeFileSync(blobTmpPath, Buffer.from(cachedBlob));
  if (platform() !== "win32") {
    try {
      chmodSync(blobTmpPath, 0o600);
    } catch {
      /* best effort */
    }
  }

  const dstHost = await DuckDBHost.openInMemory();

  try {
    const { manifest } = await readEncryptedVsk(blobTmpPath, dstHost, ownerPub, memberKp, {}, memberEnvelope);

    const tableRows = await dstHost.query("SHOW TABLES");
    const tables = tableRows.map((r) => String(r.name)).sort();

    const colRows = await dstHost.query(`
      SELECT table_name, column_name AS name, data_type AS type,
             CASE WHEN is_nullable = 'YES' THEN true ELSE false END AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'main'
      ORDER BY table_name, ordinal_position
    `);
    const columns: OpenSandboxColumn[] = colRows.map((r) => ({
      table_name: String(r.table_name),
      name: String(r.name),
      type: String(r.type),
      nullable: Boolean(r.nullable),
    }));

    const opened_at = new Date().toISOString();
    registerSession(params.sandboxId, {
      duckHost: dstHost,
      tempPath: blobTmpPath,
      openedAt: Date.parse(opened_at),
    });

    const result: OpenSandboxResult = {
      sandbox_id: params.sandboxId,
      tables,
      columns,
      opened_at,
      status: "open",
      skippedObjects: manifest.skippedObjects,
    };
    SESSION_RESULT_CACHE.set(params.sandboxId, result);
    return result;
  } catch (err) {
    try {
      await dstHost.close();
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** Internal helper used by tests and close.ts (Task 6) to drop a result-cache entry. */
export function _evictResultCache(sandboxId: string): void {
  SESSION_RESULT_CACHE.delete(sandboxId);
}
