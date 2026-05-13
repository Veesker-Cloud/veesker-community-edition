// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCacheEntry, resolveSandboxCacheDir } from "./cache";
import { leaveSandbox } from "./leave";
import { ApiError } from "../api/client";

let testRoot: string;

async function seedCache(sandboxId: string): Promise<string> {
  const cacheRoot = resolveSandboxCacheDir();
  await writeCacheEntry(cacheRoot, sandboxId, new Uint8Array([1, 2, 3]), {
    sandbox_id: sandboxId,
    name: "x",
    description: null,
    owner_user_id: "owner-1",
    owner_x25519_pubkey_b64: Buffer.from(new Uint8Array(32)).toString("base64"),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    ttl_days: 7,
    spec_json: null,
    sealed_envelope: {
      sealed_content_key_b64: "AA==",
      envelope_nonce_b64: "AA==",
    },
    pulled_at: new Date().toISOString(),
  });
  return join(cacheRoot, sandboxId);
}

describe("leaveSandbox", () => {
  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "veesker-plan8-leave-"));
    process.env.VEESKER_APP_DATA_DIR = testRoot;
  });

  afterEach(() => {
    delete process.env.VEESKER_APP_DATA_DIR;
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("204 path: DELETEs the right URL using the JWT-derived user id and clears the cache", async () => {
    const cachedDir = await seedCache("sb-leave-204");
    expect(existsSync(cachedDir)).toBe(true);

    const calls: string[] = [];
    const apiClient = {
      delete: async (path: string) => {
        calls.push(path);
        return null;
      },
    } as any;

    const result = await leaveSandbox({
      apiClient,
      sandboxId: "sb-leave-204",
      currentUserId: "user-jwt-sub-204",
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["/v1/sandboxes/sb-leave-204/grants/user-jwt-sub-204"]);
    expect(existsSync(cachedDir)).toBe(false);
  });

  it("404 path: idempotent success and still clears the cache", async () => {
    const cachedDir = await seedCache("sb-leave-404");
    expect(existsSync(cachedDir)).toBe(true);

    const calls: string[] = [];
    const apiClient = {
      delete: async (path: string) => {
        calls.push(path);
        throw new ApiError(404, { error: "not_found" }, `DELETE ${path} → 404`);
      },
    } as any;

    const result = await leaveSandbox({
      apiClient,
      sandboxId: "sb-leave-404",
      currentUserId: "user-jwt-sub-404",
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["/v1/sandboxes/sb-leave-404/grants/user-jwt-sub-404"]);
    expect(existsSync(cachedDir)).toBe(false);
  });

  it("403 path: throws and leaves the local cache intact", async () => {
    const cachedDir = await seedCache("sb-leave-403");
    expect(existsSync(cachedDir)).toBe(true);

    const calls: string[] = [];
    const apiClient = {
      delete: async (path: string) => {
        calls.push(path);
        throw new ApiError(403, { error: "forbidden" }, `DELETE ${path} → 403`);
      },
    } as any;

    let threw: unknown = null;
    try {
      await leaveSandbox({
        apiClient,
        sandboxId: "sb-leave-403",
        currentUserId: "user-jwt-sub-403",
      });
    } catch (err) {
      threw = err;
    }

    expect(threw).toBeInstanceOf(ApiError);
    expect((threw as ApiError).status).toBe(403);
    expect(calls).toEqual(["/v1/sandboxes/sb-leave-403/grants/user-jwt-sub-403"]);
    // cache MUST NOT be cleared when the server's intent is unclear
    expect(existsSync(cachedDir)).toBe(true);
  });
});
