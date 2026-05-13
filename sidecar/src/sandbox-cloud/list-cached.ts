import { listCacheEntries, resolveSandboxCacheDir } from "./cache";

export interface CachedSandboxSummary {
  sandbox_id: string;
  name: string;
  owner_user_id: string;
  blob_size_bytes: number;
  pulled_at: string;
  expires_at: string;
}

export interface ListCachedResult {
  sandboxes: CachedSandboxSummary[];
}

export async function listCachedSandboxes(): Promise<ListCachedResult> {
  const cacheRoot = resolveSandboxCacheDir();
  const entries = await listCacheEntries(cacheRoot);
  const sandboxes: CachedSandboxSummary[] = entries.map((m) => ({
    sandbox_id: m.sandbox_id,
    name: m.name,
    owner_user_id: m.owner_user_id,
    blob_size_bytes: m.blob_size_bytes,
    pulled_at: m.pulled_at,
    expires_at: m.expires_at,
  }));
  return { sandboxes };
}
