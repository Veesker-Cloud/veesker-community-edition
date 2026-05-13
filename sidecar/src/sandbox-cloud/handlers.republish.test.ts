import { describe, it, expect, mock } from "bun:test";

// Mock jwt-verify so tests don't need real ES256-signed tokens or a live JWKS endpoint.
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

import { handleSandboxRepublishProduction } from "./handlers";

function fakeJwt(claims: { sub: string; email: string }): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

describe("handleSandboxRepublishProduction (unit)", () => {
  it("rejects when sandboxId missing", async () => {
    let caught: unknown;
    await handleSandboxRepublishProduction({
      apiToken: fakeJwt({ sub: "u1", email: "u1@x.com" }),
      sandboxId: "",
      oracleConfig: { user: "u", password: "p", connectString: "c" },
      expectedBuildsDir: "/tmp",
    } as any).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/sandboxId/i);
  });

  it("rejects when oracleConfig missing", async () => {
    let caught: unknown;
    await handleSandboxRepublishProduction({
      apiToken: fakeJwt({ sub: "u1", email: "u1@x.com" }),
      sandboxId: "00000000-0000-0000-0000-000000000000",
      expectedBuildsDir: "/tmp",
    } as any).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/oracleConfig/i);
  });

  it("rejects when expectedBuildsDir missing", async () => {
    let caught: unknown;
    await handleSandboxRepublishProduction({
      apiToken: fakeJwt({ sub: "u1", email: "u1@x.com" }),
      sandboxId: "00000000-0000-0000-0000-000000000000",
      oracleConfig: { user: "u", password: "p", connectString: "c" },
    } as any).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/expectedBuildsDir/i);
  });

  it("rejects path-traversal sandboxId", async () => {
    let caught: unknown;
    await handleSandboxRepublishProduction({
      apiToken: fakeJwt({ sub: "u1", email: "u1@x.com" }),
      sandboxId: "../../../etc/passwd",
      oracleConfig: { user: "u", password: "p", connectString: "c" },
      expectedBuildsDir: "/tmp",
    } as any).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/invalid sandboxId/i);
  });

  it("rejects non-UUID sandboxId", async () => {
    let caught: unknown;
    await handleSandboxRepublishProduction({
      apiToken: fakeJwt({ sub: "u1", email: "u1@x.com" }),
      sandboxId: "not-a-uuid",
      oracleConfig: { user: "u", password: "p", connectString: "c" },
      expectedBuildsDir: "/tmp",
    } as any).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/invalid sandboxId/i);
  });

  // Note: a real "happy path" integration test would need to mock fetch +
  // OS keychain + buildSandbox + R2. That's a significant test-infra
  // investment — defer to manual smoke. The orchestrator itself is fully
  // unit-tested in republish.test.ts (DI, mocked deps).
});
