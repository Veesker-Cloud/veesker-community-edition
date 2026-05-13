// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  load: vi.fn(),
}));

vi.mock("$lib/connections", () => ({
  getConnection: mocks.getConnection,
}));

// Replace the real Svelte-rune-based store with a plain object so the test can
// mutate `cached` / `remote` / `all` directly. The real store derives `all`
// from `cached + remote`; the resolver only reads, never assigns.
vi.mock("$lib/stores/sandboxes.svelte", () => ({
  sandboxes: {
    cached: [] as unknown[],
    remote: [] as unknown[],
    all: [] as unknown[],
    load: mocks.load,
  },
}));

import { sandboxes } from "$lib/stores/sandboxes.svelte";
import { resolveWorkspaceSource } from "./resolve";
import { OracleWorkspaceSource } from "./oracle";
import { SandboxWorkspaceSource } from "./sandbox";
import type { SandboxSummary } from "$lib/sandbox";
import type { ConnectionFull } from "$lib/connections";

const sampleSandbox: SandboxSummary = {
  sandbox_id: "sb-1",
  name: "Q3",
  owner_user_id: "u",
  blob_size_bytes: 1,
  expires_at: "2026-12-31T00:00:00Z",
  status: "ready",
  cached: true,
  role: "member",
};

const sampleConnFull: ConnectionFull = {
  meta: {
    authType: "basic",
    id: "c-1",
    name: "PROD",
    host: "h",
    port: 1521,
    serviceName: "x",
    username: "scott",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    readOnly: false,
    warnUnsafeDml: false,
    autoPerfAnalysis: true,
  },
  passwordSet: true,
};

describe("resolveWorkspaceSource", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    sandboxes.cached = [];
    sandboxes.remote = [];
    sandboxes.all = [];
  });

  it("resolves Oracle conn id → OracleWorkspaceSource", async () => {
    mocks.getConnection.mockResolvedValue({ ok: true, data: sampleConnFull });
    const src = await resolveWorkspaceSource("c-1");
    expect(src).toBeInstanceOf(OracleWorkspaceSource);
    expect(src?.meta.kind).toBe("oracle");
    expect(src?.meta.id).toBe("c-1");
    expect(src?.meta.displayName).toBe("PROD");
  });

  it("resolves sandbox id → SandboxWorkspaceSource (already cached)", async () => {
    mocks.getConnection.mockResolvedValue({
      ok: false,
      error: { code: -32600, message: "not found" },
    });
    sandboxes.cached = [sampleSandbox];
    sandboxes.all = [sampleSandbox];
    const src = await resolveWorkspaceSource("sb-1");
    expect(src).toBeInstanceOf(SandboxWorkspaceSource);
    expect(src?.meta.kind).toBe("sandbox");
    expect(src?.meta.id).toBe("sb-1");
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("calls sandboxes.load() when store is empty, then returns null on miss", async () => {
    mocks.getConnection.mockResolvedValue({
      ok: false,
      error: { code: -32600, message: "not found" },
    });
    mocks.load.mockResolvedValue(undefined);
    const src = await resolveWorkspaceSource("sb-x");
    expect(mocks.load).toHaveBeenCalled();
    expect(src).toBeNull();
  });

  it("returns null for unknown id when both Oracle + sandbox lookups fail", async () => {
    mocks.getConnection.mockResolvedValue({
      ok: false,
      error: { code: -32600, message: "not found" },
    });
    mocks.load.mockResolvedValue(undefined);
    sandboxes.cached = [];
    sandboxes.remote = [];
    sandboxes.all = [];
    const src = await resolveWorkspaceSource("missing");
    expect(src).toBeNull();
  });

  it("does not call sandboxes.load() when remote already has entries", async () => {
    mocks.getConnection.mockResolvedValue({
      ok: false,
      error: { code: -32600, message: "not found" },
    });
    sandboxes.remote = [sampleSandbox];
    sandboxes.all = [sampleSandbox];
    const src = await resolveWorkspaceSource("sb-1");
    expect(src).toBeInstanceOf(SandboxWorkspaceSource);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("tries Oracle first — does not consult sandboxes when conn matches", async () => {
    mocks.getConnection.mockResolvedValue({ ok: true, data: sampleConnFull });
    sandboxes.cached = [sampleSandbox];
    sandboxes.all = [sampleSandbox];
    const src = await resolveWorkspaceSource("c-1");
    expect(src?.meta.kind).toBe("oracle");
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
