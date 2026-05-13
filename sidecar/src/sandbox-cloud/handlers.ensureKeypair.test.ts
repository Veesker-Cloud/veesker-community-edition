// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { sodiumReady, generateKeypair, publicKeyFromPrivate, InMemoryKeyStore } from "@veesker/engine";

// Mock jwt-verify so tests don't need real ES256-signed tokens or a live JWKS endpoint.
// verifyJwtClaims decodes the payload segment directly (same as old decodeJwtClaims)
// and returns sub+email without signature verification.
mock.module("./jwt-verify", () => ({
  verifyJwtClaims: async (token: string, _apiBaseUrl: string) => {
    if (!token) throw new Error("apiToken is empty or missing");
    const part = token.split(".")[1];
    if (!part) throw new Error("apiToken verification failed: no payload segment");
    const payload = JSON.parse(Buffer.from(part, "base64url").toString());
    if (!payload.sub) throw new Error("apiToken JWT is missing required claim 'sub'");
    if (!payload.email) throw new Error("apiToken JWT is missing required claim 'email'");
    return { sub: payload.sub as string, email: payload.email as string };
  },
  _clearJwksCache: () => {},
}));

import { handleSandboxEnsureKeypair } from "./handlers";

const SERVER_REGISTERED_AT = "2026-05-01T00:00:00.000Z";

function jwt(sub: string, email: string): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub, email })}.sig`;
}

const TEST_TOKEN = jwt("u-1", "test@x.com");

let putCalls: Array<{ path: string; body: unknown }>;
const mockApiPut = async (path: string, body: unknown) => {
  putCalls.push({ path, body });
  const pubkeyB64 = (body as any).x25519_pubkey as string;
  return { x25519_pubkey: pubkeyB64, registered_at: SERVER_REGISTERED_AT };
};

describe("handleSandboxEnsureKeypair", () => {
  beforeEach(() => {
    putCalls = [];
  });

  it("generates new keypair, stores in keystore, registers pubkey via PUT, returns server registered_at", async () => {
    await sodiumReady();
    const keystore = new InMemoryKeyStore();
    const result = await handleSandboxEnsureKeypair({
      apiBaseUrl: "https://api.test",
      apiToken: TEST_TOKEN,
    }, { keystore, apiPut: mockApiPut });

    expect(result.just_registered).toBe(true);
    expect(result.pubkey_b64).toMatch(/^[A-Za-z0-9+/=]{40,50}$/);
    expect(result.registered_at).toBe(SERVER_REGISTERED_AT);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].path).toBe("/v1/users/me/pubkey");
    expect((putCalls[0].body as any).x25519_pubkey).toBe(result.pubkey_b64);

    const stored = await keystore.getPrivateKey();
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(stored?.length).toBe(32);
  });

  it("existing keypair: PUT is still called, just_registered is false, uses server registered_at", async () => {
    await sodiumReady();
    const keystore = new InMemoryKeyStore();
    const existingKp = await generateKeypair();
    await keystore.setPrivateKey(existingKp.privateKey);
    const expectedPubkeyB64 = Buffer.from(publicKeyFromPrivate(existingKp.privateKey)).toString("base64");

    const result = await handleSandboxEnsureKeypair({
      apiBaseUrl: "https://api.test",
      apiToken: TEST_TOKEN,
    }, { keystore, apiPut: mockApiPut });

    expect(result.just_registered).toBe(false);
    expect(result.pubkey_b64).toBe(expectedPubkeyB64);
    expect(result.registered_at).toBe(SERVER_REGISTERED_AT);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].path).toBe("/v1/users/me/pubkey");
    expect((putCalls[0].body as any).x25519_pubkey).toBe(expectedPubkeyB64);
  });

  it("calls PUT every time even when keystore already has a key (always-PUT contract)", async () => {
    await sodiumReady();
    const keystore = new InMemoryKeyStore();
    const kp = await generateKeypair();
    await keystore.setPrivateKey(kp.privateKey);

    await handleSandboxEnsureKeypair({
      apiBaseUrl: "https://api.test",
      apiToken: TEST_TOKEN,
    }, { keystore, apiPut: mockApiPut });

    await handleSandboxEnsureKeypair({
      apiBaseUrl: "https://api.test",
      apiToken: TEST_TOKEN,
    }, { keystore, apiPut: mockApiPut });

    expect(putCalls).toHaveLength(2);
  });
});
