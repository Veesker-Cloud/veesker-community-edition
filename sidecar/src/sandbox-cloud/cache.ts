import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  statSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export interface SandboxCacheMeta {
  sandbox_id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  owner_x25519_pubkey_b64: string;
  blob_sha256_hex: string;
  blob_size_bytes: number;
  expires_at: string;
  ttl_days: number;
  spec_json: unknown;
  sealed_envelope: {
    sealed_content_key_b64: string;
    envelope_nonce_b64: string;
  };
  pulled_at: string;
}

export class CacheMissingError extends Error {
  constructor(sandboxId: string) {
    super(`Sandbox ${sandboxId} not in cache`);
    this.name = "CacheMissingError";
  }
}

export class CacheCorruptError extends Error {
  constructor(sandboxId: string, detail: string) {
    super(`Sandbox ${sandboxId} cache corrupt: ${detail}`);
    this.name = "CacheCorruptError";
  }
}

export function defaultAppDataDir(): string {
  const env = process.env.VEESKER_APP_DATA_DIR;
  if (env && env.trim().length > 0) return env;
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "dev.veesker.app");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "dev.veesker.app");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "dev.veesker.app");
  }
}

export function resolveSandboxCacheDir(): string {
  return join(defaultAppDataDir(), "sandbox-cache");
}

export function resolveSandboxTmpDir(): string {
  return join(defaultAppDataDir(), "sandbox-tmp");
}

function sha256Hex(bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function applyMode(p: string, mode: number): void {
  if (platform() !== "win32") {
    try { chmodSync(p, mode); } catch { /* best effort on non-POSIX */ }
  }
}

export async function writeCacheEntry(
  cacheRoot: string,
  sandboxId: string,
  blob: Uint8Array,
  meta: Omit<SandboxCacheMeta, "blob_sha256_hex" | "blob_size_bytes">,
): Promise<SandboxCacheMeta> {
  mkdirSync(cacheRoot, { recursive: true });
  applyMode(cacheRoot, 0o700);
  const dir = join(cacheRoot, sandboxId);
  mkdirSync(dir, { recursive: true });
  applyMode(dir, 0o700);

  const blobPath = join(dir, "blob.vsk");
  const metaPath = join(dir, "meta.json");

  const sha = sha256Hex(blob);
  const size = blob.byteLength;
  const finalMeta: SandboxCacheMeta = {
    ...meta,
    sandbox_id: sandboxId,
    blob_sha256_hex: sha,
    blob_size_bytes: size,
  };

  writeFileSync(blobPath, Buffer.from(blob));
  applyMode(blobPath, 0o600);
  writeFileSync(metaPath, JSON.stringify(finalMeta, null, 2));
  applyMode(metaPath, 0o600);

  return finalMeta;
}

export async function readCacheEntry(
  cacheRoot: string,
  sandboxId: string,
): Promise<{ blob: Uint8Array; meta: SandboxCacheMeta }> {
  const dir = join(cacheRoot, sandboxId);
  const blobPath = join(dir, "blob.vsk");
  const metaPath = join(dir, "meta.json");

  if (!existsSync(blobPath) || !existsSync(metaPath)) {
    throw new CacheMissingError(sandboxId);
  }

  let meta: SandboxCacheMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SandboxCacheMeta;
  } catch (e) {
    throw new CacheCorruptError(sandboxId, `meta.json parse failed: ${(e as Error).message}`);
  }

  const blob = new Uint8Array(readFileSync(blobPath));
  const computed = sha256Hex(blob);
  if (computed !== meta.blob_sha256_hex) {
    throw new CacheCorruptError(
      sandboxId,
      `sha256 mismatch (file=${computed} meta=${meta.blob_sha256_hex})`,
    );
  }

  return { blob, meta };
}

export async function listCacheEntries(cacheRoot: string): Promise<SandboxCacheMeta[]> {
  if (!existsSync(cacheRoot)) return [];

  const out: SandboxCacheMeta[] = [];
  for (const name of readdirSync(cacheRoot)) {
    const dir = join(cacheRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SandboxCacheMeta;
      if (meta.sandbox_id) out.push(meta);
    } catch {
      // skip corrupt entries
    }
  }
  return out;
}
