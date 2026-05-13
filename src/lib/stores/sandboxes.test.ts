// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/sandbox", () => ({
  listSandboxes: vi.fn(),
  pullSandbox: vi.fn(),
  openSandbox: vi.fn(),
  closeSandbox: vi.fn(),
  deleteSandbox: vi.fn(),
  leaveSandbox: vi.fn(),
  markSandboxesSeen: vi.fn(),
}));

import {
  listSandboxes,
  pullSandbox,
  openSandbox,
  closeSandbox,
  deleteSandbox,
  leaveSandbox,
  markSandboxesSeen,
} from "$lib/sandbox";
import { sandboxes } from "./sandboxes.svelte";

beforeEach(() => {
  vi.mocked(listSandboxes).mockReset();
  vi.mocked(pullSandbox).mockReset();
  vi.mocked(openSandbox).mockReset();
  vi.mocked(closeSandbox).mockReset();
  vi.mocked(deleteSandbox).mockReset();
  vi.mocked(leaveSandbox).mockReset();
  vi.mocked(markSandboxesSeen).mockReset();
  sandboxes.reset();
});

describe("sandboxes store", () => {
  it("load() populates cached + remote", async () => {
    vi.mocked(listSandboxes).mockResolvedValue({
      cached: [{ sandbox_id: "a", name: "a", owner_user_id: "o", blob_size_bytes: 1, pulled_at: "now", expires_at: "soon", status: "ready", cached: true }],
      remote: [{ sandbox_id: "b", name: "b", owner_user_id: "o", blob_size_bytes: 2, expires_at: "soon", status: "ready", cached: false }],
      lastSeenIds: [],
    });
    await sandboxes.load();
    expect(sandboxes.cached.length).toBe(1);
    expect(sandboxes.remote.length).toBe(1);
    expect(sandboxes.all.length).toBe(2);
  });

  it("pull() marks pulling state then reloads", async () => {
    vi.mocked(pullSandbox).mockResolvedValue({ sandbox_id: "x", name: "x", status: "ready", blob_size_bytes: 1, pulled_at: "now", cached: true });
    vi.mocked(listSandboxes).mockResolvedValue({ cached: [], remote: [], lastSeenIds: [] });
    vi.mocked(markSandboxesSeen).mockResolvedValue({ ok: true });
    const p = sandboxes.pull("x");
    expect(sandboxes.pulling.has("x")).toBe(true);
    await p;
    expect(sandboxes.pulling.has("x")).toBe(false);
  });

  it("open() sets active state", async () => {
    vi.mocked(openSandbox).mockResolvedValue({
      sandbox_id: "a", tables: ["t"], columns: [], opened_at: "now", status: "open",
    });
    await sandboxes.open("a");
    expect(sandboxes.active?.sandbox_id).toBe("a");
    expect(sandboxes.active?.tables).toEqual(["t"]);
  });

  it("close() clears active and invokes close RPC", async () => {
    vi.mocked(openSandbox).mockResolvedValue({ sandbox_id: "a", tables: [], columns: [], opened_at: "now", status: "open" });
    vi.mocked(closeSandbox).mockResolvedValue({ sandbox_id: "a", status: "closed" });
    await sandboxes.open("a");
    await sandboxes.close();
    expect(sandboxes.active).toBeNull();
    expect(closeSandbox).toHaveBeenCalledWith("a");
  });

  it("removeRevoked(id) drops sandbox from cached + remote", async () => {
    vi.mocked(listSandboxes).mockResolvedValue({
      cached: [{ sandbox_id: "a", name: "a", owner_user_id: "o", blob_size_bytes: 1, pulled_at: "now", expires_at: "soon", status: "ready", cached: true }],
      remote: [{ sandbox_id: "b", name: "b", owner_user_id: "o", blob_size_bytes: 2, expires_at: "soon", status: "ready", cached: false }],
      lastSeenIds: [],
    });
    await sandboxes.load();
    sandboxes.removeRevoked("a");
    expect(sandboxes.cached.find(c => c.sandbox_id === "a")).toBeUndefined();
  });

  it("load() populates lastSeenIds and computes newCount", async () => {
    vi.mocked(listSandboxes).mockResolvedValue({
      cached: [],
      remote: [
        { sandbox_id: "a", name: "a", owner_user_id: "o", blob_size_bytes: 1, expires_at: "soon", status: "ready", cached: false },
        { sandbox_id: "b", name: "b", owner_user_id: "o", blob_size_bytes: 2, expires_at: "soon", status: "ready", cached: false },
        { sandbox_id: "c", name: "c", owner_user_id: "o", blob_size_bytes: 3, expires_at: "soon", status: "ready", cached: false },
      ],
      lastSeenIds: ["a"],
    });
    await sandboxes.load();
    expect(sandboxes.lastSeenIds.has("a")).toBe(true);
    expect(sandboxes.newCount).toBe(2);
  });

  it("markAllSeen() marks all remote ids as seen and zeros newCount", async () => {
    vi.mocked(listSandboxes).mockResolvedValue({
      cached: [],
      remote: [
        { sandbox_id: "a", name: "a", owner_user_id: "o", blob_size_bytes: 1, expires_at: "soon", status: "ready", cached: false },
        { sandbox_id: "b", name: "b", owner_user_id: "o", blob_size_bytes: 2, expires_at: "soon", status: "ready", cached: false },
      ],
      lastSeenIds: [],
    });
    await sandboxes.load();
    expect(sandboxes.newCount).toBe(2);
    vi.mocked(markSandboxesSeen).mockResolvedValue({ ok: true });
    await sandboxes.markAllSeen();
    expect(markSandboxesSeen).toHaveBeenCalledWith(["a", "b"]);
    expect(sandboxes.newCount).toBe(0);
  });

  it("markAllSeen() with empty remote is a no-op", async () => {
    await sandboxes.markAllSeen();
    expect(markSandboxesSeen).not.toHaveBeenCalled();
  });

  it("markPulledAsSeen() marks single id and skips already-seen", async () => {
    vi.mocked(markSandboxesSeen).mockResolvedValue({ ok: true });
    await sandboxes.markPulledAsSeen("x");
    expect(markSandboxesSeen).toHaveBeenCalledWith(["x"]);
    expect(sandboxes.lastSeenIds.has("x")).toBe(true);
    vi.mocked(markSandboxesSeen).mockClear();
    await sandboxes.markPulledAsSeen("x");
    expect(markSandboxesSeen).not.toHaveBeenCalled();
  });

  it("leave() calls leaveSandbox and removes the sandbox locally", async () => {
    vi.mocked(listSandboxes).mockResolvedValue({
      cached: [{ sandbox_id: "a", name: "a", owner_user_id: "o", blob_size_bytes: 1, pulled_at: "now", expires_at: "soon", status: "ready", cached: true }],
      remote: [{ sandbox_id: "b", name: "b", owner_user_id: "o", blob_size_bytes: 2, expires_at: "soon", status: "ready", cached: false }],
      lastSeenIds: [],
    });
    await sandboxes.load();
    vi.mocked(leaveSandbox).mockResolvedValue({ ok: true });
    await sandboxes.leave("b");
    expect(leaveSandbox).toHaveBeenCalledWith("b");
    expect(sandboxes.remote.find((r) => r.sandbox_id === "b")).toBeUndefined();
  });

  it("leave() closes active session if it matches", async () => {
    vi.mocked(openSandbox).mockResolvedValue({ sandbox_id: "a", tables: [], columns: [], opened_at: "now", status: "open" });
    vi.mocked(closeSandbox).mockResolvedValue({ sandbox_id: "a", status: "closed" });
    vi.mocked(leaveSandbox).mockResolvedValue({ ok: true });
    vi.mocked(listSandboxes).mockResolvedValue({ cached: [], remote: [], lastSeenIds: [] });
    await sandboxes.open("a");
    expect(sandboxes.active?.sandbox_id).toBe("a");
    await sandboxes.leave("a");
    expect(sandboxes.active).toBeNull();
    expect(closeSandbox).toHaveBeenCalledWith("a");
    expect(leaveSandbox).toHaveBeenCalledWith("a");
  });

  it("pull() invokes markPulledAsSeen after successful pull", async () => {
    vi.mocked(pullSandbox).mockResolvedValue({ sandbox_id: "x", name: "x", status: "ready", blob_size_bytes: 1, pulled_at: "now", cached: true });
    vi.mocked(listSandboxes).mockResolvedValue({ cached: [], remote: [], lastSeenIds: [] });
    vi.mocked(markSandboxesSeen).mockResolvedValue({ ok: true });
    await sandboxes.pull("x");
    expect(markSandboxesSeen).toHaveBeenCalledWith(["x"]);
  });
});

import { detectStaleCache } from "./sandboxes.svelte";
import type { SandboxSummary } from "$lib/sandbox";

describe("stale-version detection (Plan 7)", () => {
  function s(partial: Partial<SandboxSummary> & { sandbox_id: string }): SandboxSummary {
    return {
      sandbox_id: partial.sandbox_id,
      name: partial.name ?? "x",
      owner_user_id: partial.owner_user_id ?? "owner-1",
      blob_size_bytes: partial.blob_size_bytes ?? 100,
      expires_at: partial.expires_at ?? new Date(Date.now() + 86400000).toISOString(),
      status: partial.status ?? "ready",
      cached: partial.cached ?? false,
      role: partial.role ?? "member",
      blob_sha256: partial.blob_sha256,
      ...partial,
    };
  }

  it("returns IDs of cached sandboxes whose remote sha differs", () => {
    const remote: SandboxSummary[] = [
      s({ sandbox_id: "a", blob_sha256: "v2-sha" }),
      s({ sandbox_id: "b", blob_sha256: "v1-sha" }),
    ];
    const cached = [
      { sandbox_id: "a", blob_sha256: "v1-sha" },
      { sandbox_id: "b", blob_sha256: "v1-sha" },
    ];
    const stale = detectStaleCache(remote, cached);
    expect(stale).toEqual(["a"]);
  });

  it("does NOT mark stale when no cached entry exists", () => {
    const remote: SandboxSummary[] = [s({ sandbox_id: "a", blob_sha256: "v1-sha" })];
    const cached: Array<{ sandbox_id: string; blob_sha256?: string | null }> = [];
    expect(detectStaleCache(remote, cached)).toEqual([]);
  });

  it("does NOT mark stale when remote has no sha (legacy/missing)", () => {
    const remote: SandboxSummary[] = [s({ sandbox_id: "a" })];
    const cached = [{ sandbox_id: "a", blob_sha256: "v1-sha" }];
    expect(detectStaleCache(remote, cached)).toEqual([]);
  });

  it("populates store.staleVersionIds after load()", async () => {
    vi.mocked(listSandboxes).mockResolvedValue({
      cached: [s({ sandbox_id: "a", cached: true, blob_sha256: "v1-sha" })],
      remote: [s({ sandbox_id: "a", blob_sha256: "v2-sha" })],
      lastSeenIds: [],
    });
    await sandboxes.load();
    expect(sandboxes.isStaleVersion("a")).toBe(true);
    expect(sandboxes.isStaleVersion("nonexistent")).toBe(false);
  });
});
