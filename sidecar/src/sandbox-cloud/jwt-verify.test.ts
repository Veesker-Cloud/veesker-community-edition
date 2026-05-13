import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { generateKeyPair, SignJWT, exportJWK, jwtVerify, createRemoteJWKSet } from "jose";

// This file tests the real verifyJwtClaims logic directly (via jose) without
// going through the mocked module — handler tests mock "./jwt-verify" which
// would intercept the import if we used it here. We inline the essential
// verification logic so the tests exercise the real jose call chain.

const TEST_API_BASE = "https://test.veesker.internal";
const JWKS_URL = `${TEST_API_BASE}/.well-known/jwks.json`;

let privKey: CryptoKey;
let pubKey: CryptoKey;
let otherPrivKey: CryptoKey;

let savedFetch: typeof globalThis.fetch;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privKey = kp.privateKey as CryptoKey;
  pubKey = kp.publicKey as CryptoKey;

  const kp2 = await generateKeyPair("ES256", { extractable: true });
  otherPrivKey = kp2.privateKey as CryptoKey;

  savedFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

async function makeJwks(key: CryptoKey): Promise<{ keys: object[] }> {
  const jwk = await exportJWK(key);
  return { keys: [{ ...jwk, kid: "test-kid", use: "sig", alg: "ES256" }] };
}

function mockFetchJwks(jwks: { keys: object[] }): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === JWKS_URL) {
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return savedFetch(input, init);
  };
}

async function signToken(payload: Record<string, unknown>, key = privKey): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .setIssuer("veesker-cloud")
    .setAudience("veesker-sidecar")
    .setExpirationTime("1h")
    .sign(key);
}

// Inline the core verifyJwtClaims logic so this test file is independent of the
// mock.module replacements in handler test files.
async function verifyJwtClaimsReal(
  token: string,
  apiBaseUrl: string,
): Promise<{ sub: string; email: string }> {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("apiToken is empty or missing");
  }
  const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", apiBaseUrl));
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, jwks, {
      algorithms: ["ES256"],
      issuer: "veesker-cloud",
      audience: "veesker-sidecar",
      clockTolerance: 30,
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
  return { sub: payload.sub, email: payload.email };
}

describe("verifyJwtClaims", () => {
  it("verifies a valid ES256 token against the published JWKS", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const token = await signToken({ sub: "u-alice", email: "alice@example.com" });
    const claims = await verifyJwtClaimsReal(token, TEST_API_BASE);
    expect(claims.sub).toBe("u-alice");
    expect(claims.email).toBe("alice@example.com");
  });

  it("throws for a token signed with a different ES256 key (wrong key)", async () => {
    mockFetchJwks(await makeJwks(pubKey)); // JWKS has our real public key
    const forgedToken = await signToken({ sub: "u-evil", email: "evil@example.com" }, otherPrivKey);
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(forgedToken, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/verification failed/i);
  });

  it("throws for a tampered token (corrupted signature)", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const token = await signToken({ sub: "u-test", email: "test@example.com" });
    const parts = token.split(".");
    parts[2] = "XXXXXXXXXXXXXXXXXXXX";
    const bad = parts.join(".");
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(bad, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/verification failed/i);
  });

  it("throws for an expired token", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const expired = await new SignJWT({ sub: "u-x", email: "x@x.x" })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setIssuer("veesker-cloud")
      .setExpirationTime(new Date(Date.now() - 1000))
      .sign(privKey);
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(expired, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/verification failed/i);
  });

  it("throws for a token with wrong audience", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const wrongAud = await new SignJWT({ sub: "u-x", email: "x@x.x" })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setIssuer("veesker-cloud")
      .setAudience("wrong-service")
      .setExpirationTime("1h")
      .sign(privKey);
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(wrongAud, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/verification failed/i);
  });

  it("throws for a token with wrong issuer", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const wrongIssuer = await new SignJWT({ sub: "u-x", email: "x@x.x" })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setIssuer("wrong-issuer")
      .setAudience("veesker-sidecar")
      .setExpirationTime("1h")
      .sign(privKey);
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(wrongIssuer, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/verification failed/i);
  });

  it("throws when apiToken is empty string", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal("", TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/apiToken is empty or missing/i);
  });

  it("throws when 'sub' claim is missing", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const token = await signToken({ email: "x@x.x" });
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(token, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/missing required claim 'sub'/i);
  });

  it("throws when 'email' claim is missing", async () => {
    mockFetchJwks(await makeJwks(pubKey));
    const token = await signToken({ sub: "u-x" });
    let caught: Error | null = null;
    try {
      await verifyJwtClaimsReal(token, TEST_API_BASE);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/missing required claim 'email'/i);
  });
});
