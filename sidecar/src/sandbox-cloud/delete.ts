import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../api/client";
import { resolveSandboxCacheDir } from "./cache";

export interface DeleteSandboxParams {
  apiClient: { delete: (path: string) => Promise<unknown> };
  sandboxId: string;
}

export interface DeleteSandboxResult {
  remote: "deleted" | "not_owner" | "not_found";
  cache: "deleted" | "missing";
}

/**
 * Owner-side soft delete on the API (status='deleted') plus best-effort
 * removal of the local cache directory. Members get `remote: "not_owner"`
 * — the API returns 403 — and we still clean their cache so the entry
 * disappears from the listing on the next load. 404 means the row is
 * already gone (e.g. another device deleted it first); treat as success.
 */
export async function deleteSandbox(
  params: DeleteSandboxParams,
): Promise<DeleteSandboxResult> {
  let remote: DeleteSandboxResult["remote"];
  try {
    await params.apiClient.delete(`/v1/sandboxes/${params.sandboxId}`);
    remote = "deleted";
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 403) remote = "not_owner";
      else if (err.status === 404) remote = "not_found";
      else throw err;
    } else {
      throw err;
    }
  }

  const dir = join(resolveSandboxCacheDir(), params.sandboxId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    return { remote, cache: "deleted" };
  }
  return { remote, cache: "missing" };
}
