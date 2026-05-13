// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import {
  listSandboxes,
  pullSandbox,
  openSandbox,
  closeSandbox,
  deleteSandbox,
  leaveSandbox,
  markSandboxesSeen,
  type SandboxSummary,
  type OpenSandboxResult,
} from "$lib/sandbox";

/** Plan 7: detect sandboxes whose cached blob_sha256 differs from the
 *  fresh remote sha — owner has republished and the local cache is stale.
 *  Returns the sandbox IDs that need re-pulling. */
export function detectStaleCache(
  remote: Pick<SandboxSummary, "sandbox_id" | "blob_sha256">[],
  cached: Array<{ sandbox_id: string; blob_sha256?: string | null }>,
): string[] {
  const stale: string[] = [];
  const cachedMap = new Map(cached.map((c) => [c.sandbox_id, c.blob_sha256 ?? null]));
  for (const r of remote) {
    if (!r.blob_sha256) continue;
    const cachedSha = cachedMap.get(r.sandbox_id);
    if (cachedSha && cachedSha !== r.blob_sha256) {
      stale.push(r.sandbox_id);
    }
  }
  return stale;
}

class SandboxesStore {
  cached = $state<SandboxSummary[]>([]);
  remote = $state<SandboxSummary[]>([]);
  active = $state<OpenSandboxResult | null>(null);
  pulling = $state<Set<string>>(new Set());
  loading = $state(false);
  error = $state<string | null>(null);
  lastSeenIds = $state<Set<string>>(new Set());
  staleVersionIds = $state<Set<string>>(new Set());
  newCount = $derived(
    this.remote.filter((r) => !this.lastSeenIds.has(r.sandbox_id)).length,
  );

  all = $derived([...this.cached, ...this.remote]);

  isStaleVersion(sandboxId: string): boolean {
    return this.staleVersionIds.has(sandboxId);
  }

  reset() {
    this.cached = [];
    this.remote = [];
    this.active = null;
    this.pulling = new Set();
    this.loading = false;
    this.error = null;
    this.lastSeenIds = new Set();
    this.staleVersionIds = new Set();
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const { cached, remote, lastSeenIds } = await listSandboxes();
      this.cached = cached;
      this.remote = remote;
      this.lastSeenIds = new Set(lastSeenIds);
      this.staleVersionIds = new Set(detectStaleCache(remote, cached));
    } catch (e) {
      this.error = (e as Error).message ?? String(e);
    } finally {
      this.loading = false;
    }
  }

  async pull(sandboxId: string) {
    const next = new Set(this.pulling);
    next.add(sandboxId);
    this.pulling = next;
    try {
      await pullSandbox(sandboxId);
      await this.markPulledAsSeen(sandboxId);
      await this.load();
    } finally {
      const after = new Set(this.pulling);
      after.delete(sandboxId);
      this.pulling = after;
    }
  }

  async open(sandboxId: string) {
    const result = await openSandbox(sandboxId);
    this.active = result;
  }

  async close() {
    if (!this.active) return;
    const id = this.active.sandbox_id;
    this.active = null;
    try {
      await closeSandbox(id);
    } catch {
      /* best effort */
    }
  }

  removeRevoked(sandboxId: string) {
    this.cached = this.cached.filter(c => c.sandbox_id !== sandboxId);
    this.remote = this.remote.filter(r => r.sandbox_id !== sandboxId);
    if (this.active?.sandbox_id === sandboxId) {
      this.active = null;
    }
  }

  async delete(sandboxId: string) {
    if (this.active?.sandbox_id === sandboxId) {
      // Drop the active session before nuking the cache; closeSandbox is
      // best-effort but skipping it leaves the sidecar holding a DuckDB
      // handle on a directory we just removed.
      await this.close();
    }
    try {
      await deleteSandbox(sandboxId);
    } catch (e) {
      this.error = (e as Error).message ?? String(e);
      throw e;
    }
    // Optimistic local removal so the card disappears immediately; load()
    // re-syncs from server in case anything else changed.
    this.cached = this.cached.filter(c => c.sandbox_id !== sandboxId);
    this.remote = this.remote.filter(r => r.sandbox_id !== sandboxId);
    void this.load();
  }

  republish(sandboxId: string): { sandboxId: string } {
    const sandbox = this.all.find((s) => s.sandbox_id === sandboxId);
    if (!sandbox) throw new Error(`sandbox ${sandboxId} not found`);
    if (sandbox.status !== "ready") {
      throw new Error("can only republish a ready sandbox");
    }
    // Pure validation — caller routes to /sandboxes/publish?republishId=<id>.
    // Decoupling navigation from the store keeps $app/navigation out of the
    // data layer and lets pages catch validation errors via try/catch.
    return { sandboxId };
  }

  async leave(sandboxId: string) {
    if (this.active?.sandbox_id === sandboxId) {
      await this.close();
    }
    try {
      await leaveSandbox(sandboxId);
    } catch (e) {
      this.error = (e as Error).message ?? String(e);
      throw e;
    }
    // Optimistic local removal — load() re-syncs.
    this.cached = this.cached.filter((c) => c.sandbox_id !== sandboxId);
    this.remote = this.remote.filter((r) => r.sandbox_id !== sandboxId);
    void this.load();
  }

  async markAllSeen() {
    const ids = this.remote.map((r) => r.sandbox_id);
    if (ids.length === 0) return;
    try {
      await markSandboxesSeen(ids);
    } catch (e) {
      this.error = (e as Error).message ?? String(e);
      return;
    }
    const next = new Set(this.lastSeenIds);
    for (const id of ids) next.add(id);
    this.lastSeenIds = next;
  }

  async markPulledAsSeen(sandboxId: string) {
    if (this.lastSeenIds.has(sandboxId)) return;
    try {
      await markSandboxesSeen([sandboxId]);
    } catch {
      return;
    }
    const next = new Set(this.lastSeenIds);
    next.add(sandboxId);
    this.lastSeenIds = next;
  }
}

export const sandboxes = new SandboxesStore();
