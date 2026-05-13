import { describe, it, expect, mock, beforeAll } from "bun:test";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT, exportJWK } from "jose";
import { _clearJwksCache } from "./jwt-verify";

// Test keypair — generated once for the whole describe block.
let privKey: CryptoKey;
let pubKey: CryptoKey;
let jwksPayload: { keys: object[] };

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privKey = kp.privateKey as CryptoKey;
  pubKey = kp.publicKey as CryptoKey;
  const jwk = await exportJWK(pubKey);
  jwksPayload = { keys: [{ ...jwk, kid: "test-kid", use: "sig", alg: "ES256" }] };

  // Stub global fetch so createRemoteJWKSet returns our test public key.
  const originalFetch = globalThis.fetch;
  mock.module("./jwt-verify", () => {
    const { jwtVerify, createRemoteJWKSet } = require("jose");
    // Return a verifyJwtClaims that validates against our test public key.
    return {
      verifyJwtClaims: async (token: string, _apiBaseUrl: string) => {
        if (typeof token !== "string" || token.length === 0) {
          throw new Error("apiToken is empty or missing");
        }
        let payload: Record<string, unknown>;
        try {
          const result = await jwtVerify(token, pubKey, {
            algorithms: ["ES256"],
            issuer: "veesker-cloud",
          });
          payload = result.payload as Record<string, unknown>;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`apiToken verification failed: ${reason}`);
        }
        if (typeof payload.sub !== "string" || payload.sub.length === 0) {
          throw new Error("apiToken JWT is missing required claim 'sub'");
        }
        if (typeof payload.email !== "string" || payload.email.length === 0) {
          throw new Error("apiToken JWT is missing required claim 'email'");
        }
        return { sub: payload.sub as string, email: payload.email as string };
      },
      _clearJwksCache: () => {},
    };
  });
});

async function signedJwt(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .setIssuer("veesker-cloud")
    .setExpirationTime("1h")
    .sign(privKey);
}

describe("expandSandboxEnvelope", () => {
  it("derives ownerAccount and ownerUserId from JWT claims", async () => {
    const { expandSandboxEnvelope } = await import(`./handlers?t=${Date.now()}`);
    const token = await signedJwt({ sub: "u-alice", email: "alice@example.com" });
    const result = await expandSandboxEnvelope({ apiToken: token });
    expect(result.ownerAccount).toBe("alice@example.com");
    expect(result.ownerUserId).toBe("u-alice");
    expect(result.apiBaseUrl).toBe("https://api.veesker.cloud");
  });

  it("ignores renderer-supplied ownerAccount/ownerUserId in favor of JWT-derived", async () => {
    const { expandSandboxEnvelope } = await import("./handlers");
    const token = await signedJwt({ sub: "u-alice", email: "alice@example.com" });
    const result = await expandSandboxEnvelope({
      apiToken: token,
      ownerAccount: "evil@attacker.com",
      ownerUserId: "u-evil",
    });
    expect(result.ownerAccount).toBe("alice@example.com");
    expect(result.ownerUserId).toBe("u-alice");
  });

  it("respects supplied apiBaseUrl over default", async () => {
    const { expandSandboxEnvelope } = await import("./handlers");
    const token = await signedJwt({ sub: "u-x", email: "x@y.z" });
    const result = await expandSandboxEnvelope({
      apiToken: token,
      apiBaseUrl: "https://staging.example.com",
    });
    expect(result.apiBaseUrl).toBe("https://staging.example.com");
  });

  it("throws when apiToken is empty string", async () => {
    const { expandSandboxEnvelope } = await import("./handlers");
    let caught: Error | null = null;
    try {
      await expandSandboxEnvelope({ apiToken: "" });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/apiToken is empty or missing/i);
  });

  it("throws when apiToken signature is invalid", async () => {
    const { expandSandboxEnvelope } = await import("./handlers");
    const token = await signedJwt({ sub: "u-x", email: "x@y.z" });
    const parts = token.split(".");
    parts[2] = "invalidsig";
    const bad = parts.join(".");
    let caught: Error | null = null;
    try {
      await expandSandboxEnvelope({ apiToken: bad });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/verification failed/i);
  });

  it("throws when JWT claims are missing 'sub'", async () => {
    const { expandSandboxEnvelope } = await import("./handlers");
    const token = await signedJwt({ email: "alice@example.com" });
    let caught: Error | null = null;
    try {
      await expandSandboxEnvelope({ apiToken: token });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/missing required claim 'sub'/i);
  });

  it("throws when JWT claims are missing 'email'", async () => {
    const { expandSandboxEnvelope } = await import("./handlers");
    const token = await signedJwt({ sub: "u-alice" });
    let caught: Error | null = null;
    try {
      await expandSandboxEnvelope({ apiToken: token });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/missing required claim 'email'/i);
  });
});
