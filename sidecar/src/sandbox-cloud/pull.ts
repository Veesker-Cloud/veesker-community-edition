import { writeCacheEntry, resolveSandboxCacheDir, type SandboxCacheMeta } from "./cache";

export interface PullParams {
  apiClient: { get: <T = unknown>(path: string) => Promise<T> };
  sandboxId: string;
  downloader: (url: string) => Promise<Uint8Array>;
}

export interface PullResult {
  sandbox_id: string;
  name: string;
  status: "ready" | "expired" | "deleted";
  blob_size_bytes: number;
  pulled_at: string;
  cached: true;
}

interface ApiSandboxResponse {
  sandbox: {
    id: string;
    owner_user_id: string;
    name: string;
    description: string | null;
    status: "ready" | "expired" | "deleted";
    blob_sha256_hex: string;
    blob_size_bytes: number;
    expires_at: string;
    ttl_days: number;
    spec_json: unknown;
  };
  download_url: string;
  download_expires_at: string;
  sealed_envelope: {
    sealed_content_key: string;
    envelope_nonce: string;
  };
}

interface PubkeyResponse {
  user_id: string;
  x25519_pubkey: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function pullSandbox(params: PullParams): Promise<PullResult> {
  const resp = await params.apiClient.get<ApiSandboxResponse>(`/v1/sandboxes/${params.sandboxId}`);
  const blob = await params.downloader(resp.download_url);

  const computedSha = await sha256Hex(blob);
  if (computedSha !== resp.sandbox.blob_sha256_hex) {
    throw new Error(`sha256 mismatch: expected ${resp.sandbox.blob_sha256_hex}, got ${computedSha}`);
  }

  const ownerPubResp = await params.apiClient.get<PubkeyResponse>(
    `/v1/users/${resp.sandbox.owner_user_id}/pubkey`,
  );

  const cacheRoot = resolveSandboxCacheDir();
  const meta: Omit<SandboxCacheMeta, "blob_sha256_hex" | "blob_size_bytes"> = {
    sandbox_id: resp.sandbox.id,
    name: resp.sandbox.name,
    description: resp.sandbox.description,
    owner_user_id: resp.sandbox.owner_user_id,
    owner_x25519_pubkey_b64: ownerPubResp.x25519_pubkey,
    expires_at: resp.sandbox.expires_at,
    ttl_days: resp.sandbox.ttl_days,
    spec_json: resp.sandbox.spec_json,
    sealed_envelope: {
      sealed_content_key_b64: resp.sealed_envelope.sealed_content_key,
      envelope_nonce_b64: resp.sealed_envelope.envelope_nonce,
    },
    pulled_at: new Date().toISOString(),
  };

  const written = await writeCacheEntry(cacheRoot, params.sandboxId, blob, meta);

  return {
    sandbox_id: written.sandbox_id,
    name: written.name,
    status: resp.sandbox.status,
    blob_size_bytes: written.blob_size_bytes,
    pulled_at: written.pulled_at,
    cached: true,
  };
}

export async function downloadViaFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
