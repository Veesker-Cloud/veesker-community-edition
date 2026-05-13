// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/sandbox", () => ({
  ensureSandboxKeypair: vi.fn(),
}));

import { ensureSandboxKeypair } from "$lib/sandbox";
import { sandboxKeypair } from "./sandbox-keypair.svelte";

beforeEach(() => {
  vi.mocked(ensureSandboxKeypair).mockReset();
  sandboxKeypair.reset();
});

describe("sandboxKeypair store", () => {
  it("starts unregistered", () => {
    expect(sandboxKeypair.isRegistered).toBe(false);
    expect(sandboxKeypair.pubkey_b64).toBeNull();
  });

  it("ensure() populates state on success", async () => {
    vi.mocked(ensureSandboxKeypair).mockResolvedValue({
      pubkey_b64: "abc==",
      registered_at: "2026-05-01T00:00:00Z",
      just_registered: true,
    });
    await sandboxKeypair.ensure();
    expect(sandboxKeypair.isRegistered).toBe(true);
    expect(sandboxKeypair.pubkey_b64).toBe("abc==");
    expect(sandboxKeypair.registered_at).toBe("2026-05-01T00:00:00Z");
    expect(sandboxKeypair.error).toBeNull();
  });

  it("ensure() captures error without throwing", async () => {
    vi.mocked(ensureSandboxKeypair).mockRejectedValue(new Error("keystore denied"));
    await sandboxKeypair.ensure();
    expect(sandboxKeypair.isRegistered).toBe(false);
    expect(sandboxKeypair.error).toMatch(/keystore denied/);
  });
});
