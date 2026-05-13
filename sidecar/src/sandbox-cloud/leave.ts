// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../api/client";
import { resolveSandboxCacheDir } from "./cache";

export interface SandboxLeaveParams {
  apiClient: { delete: (path: string) => Promise<unknown> };
  sandboxId: string;
  /** User id of the caller (the member leaving). Resolved from the JWT
   *  in the handler wrapper before reaching this function — never trust
   *  a renderer-supplied value here. */
  currentUserId: string;
}

export interface SandboxLeaveResult {
  ok: true;
}

/**
 * Member-side self-revoke: drops the caller's grant on a sandbox and
 * deletes the local cache. Idempotent on the API side — a 404 means the
 * grant was already revoked (e.g. the owner revoked, or another device
 * leave-ed first), which we still treat as success. Any other error
 * (most importantly 403, where the server explicitly refuses) bubbles
 * up untouched and the local cache is preserved: clearing it under
 * unclear server state would orphan the user from a sandbox they may
 * still legitimately have access to.
 */
export async function leaveSandbox(
  params: SandboxLeaveParams,
): Promise<SandboxLeaveResult> {
  const path = `/v1/sandboxes/${params.sandboxId}/grants/${params.currentUserId}`;
  try {
    await params.apiClient.delete(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // already revoked — fall through to cache cleanup
    } else {
      // 403 + 5xx + non-ApiError network failures: bail without touching cache
      throw err;
    }
  }

  const dir = join(resolveSandboxCacheDir(), params.sandboxId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  return { ok: true };
}
