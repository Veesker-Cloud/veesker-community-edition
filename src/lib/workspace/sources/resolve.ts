// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { getConnection } from "$lib/connections";
import { sandboxes } from "$lib/stores/sandboxes.svelte";
import { OracleWorkspaceSource } from "./oracle";
import { SandboxWorkspaceSource } from "./sandbox";
import type { WorkspaceSource } from "./types";

/**
 * Resolve a workspace id to a concrete WorkspaceSource.
 *
 * Order:
 *   1. Try Oracle connection lookup (local SQLite — fast).
 *   2. Fall back to sandbox lookup. If the sandboxes store is empty, lazily
 *      load it once.
 *   3. Return null on miss so the caller can throw 404.
 *
 * `getConnection` returns `{ok: false, error}` for unknown ids (the underlying
 * Tauri command throws), so we treat any non-ok response as "not an Oracle id"
 * and continue to sandbox.
 */
export async function resolveWorkspaceSource(
  id: string,
): Promise<WorkspaceSource | null> {
  const conn = await getConnection(id);
  if (conn.ok && conn.data) return new OracleWorkspaceSource(conn.data.meta);

  if (sandboxes.cached.length === 0 && sandboxes.remote.length === 0) {
    await sandboxes.load();
  }
  const sb = sandboxes.all.find((s) => s.sandbox_id === id);
  if (sb) return new SandboxWorkspaceSource(sb);

  return null;
}
