import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuckDBHost,
  generateKeypair,
  InMemoryKeyStore,
  publicKeyFromPrivate,
  randomKey,
  sealEnvelope,
  sodiumReady,
  writeEncryptedVsk,
  type VskManifest,
} from "@veesker/engine";

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

import { handleSandboxPublish } from "./handlers";
import {
  setUploadChunkBytesForTesting,
  resetUploadChunkBytesForTesting,
} from "./publish";

let testRoot: string;
let anchor: string;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-publish-handler-"));
  anchor = join(testRoot, "sandbox-builds");
  mkdirSync(anchor, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function buildFixture(
  outPath: string,
  ownerKp: { privateKey: Uint8Array; publicKey: Uint8Array },
  contentKey: Uint8Array,
) {
  const src = await DuckDBHost.openInMemory();
  await src.exec(`CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)`);
  const manifest: VskManifest = {
    builtAt: new Date().toISOString(),
    sourceId: crypto.randomUUID(),
    schemaName: "TEST",
    ttlExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    tables: [
      {
        name: "T",
        rowCount: 1,
        columns: [{ name: "A", type: "INTEGER", nullable: true }],
      },
    ],
    piiMasks: [],
  };
  const ownerEnvelope = await sealEnvelope(
    contentKey,
    publicKeyFromPrivate(ownerKp.privateKey),
    ownerKp,
  );
  await writeEncryptedVsk(src, outPath, manifest, contentKey, ownerEnvelope);
  await src.close();
}

function jwt(sub: string, email: string): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub, email })}.sig`;
}

describe("handleSandboxPublish (disk-derived contentKey)", () => {
  it("publishes from a real .vsk on disk", async () => {
    const ownerKp = await generateKeypair();
    const ownerAccount = "alice@example.com";
    const ownerUserId = "u-alice";

    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(ownerKp.privateKey);

    const contentKey = randomKey();
    const fixturePath = join(anchor, `sb-${Date.now()}.vsk`);
    await buildFixture(fixturePath, ownerKp, contentKey);

    const recordedUploads: Array<{ url: string; bytes: number }> = [];
    const recordedPosts: Array<{ path: string; body: unknown }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "PUT") {
        const body = init.body as Uint8Array;
        recordedUploads.push({ url, bytes: body.byteLength });
        return new Response(null, { status: 200 });
      }
      if (init?.method === "POST") {
        const path = url.replace("https://api.veesker.cloud", "");
        const body = JSON.parse(String(init.body));
        recordedPosts.push({ path, body });
        if (path === "/v1/sandboxes") {
          return new Response(
            JSON.stringify({
              sandbox_id: "sb-test-1",
              upload_url: "https://r2.example.com/upload",
              upload_expires_at: new Date(Date.now() + 60_000).toISOString(),
              recipients: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (path.endsWith("/finalize")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as typeof fetch;

    try {
      const result = await handleSandboxPublish(
        {
          apiToken: jwt(ownerUserId, ownerAccount),
          outPath: fixturePath,
          expectedBuildsDir: anchor,
          sandboxName: "test",
          ttlDays: 7,
          memberUserIds: [],
          specJson: { source: { schemaName: "TEST" } },
        },
        { keystore },
      );

      expect(result.sandboxId).toBe("sb-test-1");
      expect(recordedUploads).toHaveLength(1);
      expect(recordedPosts.map((p) => p.path)).toEqual([
        "/v1/sandboxes",
        "/v1/sandboxes/sb-test-1/finalize",
      ]);
      // R2 has the official copy after a successful publish; the local
      // build artifact in app_data/sandbox-builds/ no longer needs to live.
      expect(existsSync(fixturePath)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves the local .vsk in place when publish fails (upload network error)", async () => {
    const ownerKp = await generateKeypair();
    const ownerAccount = "carol@example.com";

    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(ownerKp.privateKey);

    const contentKey = randomKey();
    const fixturePath = join(anchor, `sb-${Date.now()}-fail.vsk`);
    await buildFixture(fixturePath, ownerKp, contentKey);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.endsWith("/v1/sandboxes")) {
        return new Response(
          JSON.stringify({
            sandbox_id: "sb-test-2",
            upload_url: "https://r2.example.com/upload",
            upload_expires_at: new Date(Date.now() + 60_000).toISOString(),
            recipients: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (init?.method === "PUT") {
        // Simulate the upload to R2 failing — publish must not delete the
        // local .vsk in this case (the user may want to retry).
        throw new Error("simulated network failure");
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as typeof fetch;

    try {
      await expect(
        handleSandboxPublish(
          {
            apiToken: jwt("u-carol", ownerAccount),
            outPath: fixturePath,
            expectedBuildsDir: anchor,
            sandboxName: "test",
            ttlDays: 7,
            memberUserIds: [],
            specJson: { source: { schemaName: "TEST" } },
          },
          { keystore },
        ),
      ).rejects.toThrow(/simulated network failure/);
      expect(existsSync(fixturePath)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatches sandbox.upload-progress notifications when given a dispatcher", async () => {
    const ownerKp = await generateKeypair();
    const ownerAccount = "diana@example.com";
    const ownerUserId = "u-diana";

    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(ownerKp.privateKey);

    const contentKey = randomKey();
    const fixturePath = join(anchor, `sb-${Date.now()}-progress.vsk`);
    await buildFixture(fixturePath, ownerKp, contentKey);

    const notifications: Array<{ method: string; params: unknown }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "PUT") {
        // Drain whatever body the uploader sent us so streaming progress
        // callbacks fire end-to-end.
        if (init.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
        return new Response(null, { status: 200 });
      }
      if (init?.method === "POST") {
        const path = url.replace("https://api.veesker.cloud", "");
        if (path === "/v1/sandboxes") {
          return new Response(
            JSON.stringify({
              sandbox_id: "sb-progress-1",
              upload_url: "https://r2.example.com/upload",
              upload_expires_at: new Date(Date.now() + 60_000).toISOString(),
              recipients: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (path.endsWith("/finalize")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as typeof fetch;

    try {
      await handleSandboxPublish(
        {
          apiToken: jwt(ownerUserId, ownerAccount),
          outPath: fixturePath,
          expectedBuildsDir: anchor,
          sandboxName: "progress-test",
          ttlDays: 7,
          memberUserIds: [],
          specJson: { source: { schemaName: "TEST" } },
        },
        {
          keystore,
          dispatchNotification: (n) => {
            notifications.push(n);
          },
        },
      );

      const progress = notifications.filter(
        (n) => n.method === "sandbox.upload-progress",
      );
      // The fixture is small (well under the 64 KiB streaming threshold), so
      // the implementation falls through to the non-streaming path and emits
      // a single completion tick. That's still proof the wiring fires.
      expect(progress.length).toBeGreaterThanOrEqual(1);
      const last = progress[progress.length - 1].params as {
        sandboxName: string;
        bytesUploaded: number;
        totalBytes: number;
      };
      expect(last.sandboxName).toBe("progress-test");
      expect(last.bytesUploaded).toBe(last.totalBytes);
      expect(last.totalBytes).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatches multiple progress notifications across the streaming chunks", async () => {
    // Drop the chunk threshold so even our small test fixture exercises the
    // streaming path end-to-end, not the single-completion-tick fallback.
    setUploadChunkBytesForTesting(256);
    try {
      const ownerKp = await generateKeypair();
      const ownerAccount = "eve@example.com";
      const ownerUserId = "u-eve";

      const keystore = new InMemoryKeyStore();
      await keystore.setPrivateKey(ownerKp.privateKey);

      const contentKey = randomKey();
      const fixturePath = join(anchor, `sb-${Date.now()}-multichunk.vsk`);
      await buildFixture(fixturePath, ownerKp, contentKey);

      const notifications: Array<{ method: string; params: unknown }> = [];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        if (init?.method === "PUT") {
          if (init.body instanceof ReadableStream) {
            const reader = init.body.getReader();
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          }
          return new Response(null, { status: 200 });
        }
        if (init?.method === "POST") {
          const path = url.replace("https://api.veesker.cloud", "");
          if (path === "/v1/sandboxes") {
            return new Response(
              JSON.stringify({
                sandbox_id: "sb-multi-1",
                upload_url: "https://r2.example.com/upload",
                upload_expires_at: new Date(Date.now() + 60_000).toISOString(),
                recipients: [],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (path.endsWith("/finalize")) {
            return new Response("{}", {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        throw new Error(`unexpected fetch ${init?.method} ${url}`);
      }) as typeof fetch;

      try {
        await handleSandboxPublish(
          {
            apiToken: jwt(ownerUserId, ownerAccount),
            outPath: fixturePath,
            expectedBuildsDir: anchor,
            sandboxName: "multichunk-test",
            ttlDays: 7,
            memberUserIds: [],
            specJson: { source: { schemaName: "TEST" } },
          },
          {
            keystore,
            dispatchNotification: (n) => {
              notifications.push(n);
            },
          },
        );

        const progress = notifications
          .filter((n) => n.method === "sandbox.upload-progress")
          .map(
            (n) =>
              n.params as {
                sandboxName: string;
                bytesUploaded: number;
                totalBytes: number;
              },
          );

        // With a 256-byte chunk size and a >256-byte fixture, expect at
        // least 2 ticks. All carry the same sandboxName. bytesUploaded is
        // monotonically non-decreasing and the final tick equals totalBytes.
        expect(progress.length).toBeGreaterThanOrEqual(2);
        for (const p of progress) {
          expect(p.sandboxName).toBe("multichunk-test");
          expect(p.totalBytes).toBeGreaterThan(0);
        }
        for (let i = 1; i < progress.length; i++) {
          expect(progress[i].bytesUploaded).toBeGreaterThanOrEqual(
            progress[i - 1].bytesUploaded,
          );
          expect(progress[i].totalBytes).toBe(progress[0].totalBytes);
        }
        expect(progress[progress.length - 1].bytesUploaded).toBe(
          progress[0].totalBytes,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      resetUploadChunkBytesForTesting();
    }
  });

  it("rejects an outPath outside the expected anchor", async () => {
    const ownerKp = await generateKeypair();
    const ownerAccount = "bob@example.com";
    const keystore = new InMemoryKeyStore();
    await keystore.setPrivateKey(ownerKp.privateKey);

    await expect(
      handleSandboxPublish(
        {
          apiToken: jwt("u-bob", ownerAccount),
          outPath: join(testRoot, "evil.vsk"),
          expectedBuildsDir: anchor,
          sandboxName: "test",
          ttlDays: 7,
          memberUserIds: [],
          specJson: {},
        },
        { keystore },
      ),
    ).rejects.toThrow(/outside expected directory/);
  });
});
