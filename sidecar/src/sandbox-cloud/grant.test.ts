import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sodiumReady,
  generateKeypair,
  publicKeyFromPrivate,
  sealEnvelope,
  openEnvelope,
  randomKey,
} from "@veesker/engine";
import { writeCacheEntry } from "./cache";
import { grantSandbox, revokeSandbox, listSandboxes } from "./grant";

let testRoot: string;

describe("grantSandbox", () => {
  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "veesker-plan4-grant-"));
    process.env.VEESKER_APP_DATA_DIR = testRoot;
  });

  afterEach(() => {
    delete process.env.VEESKER_APP_DATA_DIR;
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("reads cache, recovers contentKey, re-seals for new member, posts to /grants", async () => {
    await sodiumReady();
    const ownerKp = await generateKeypair();
    const newMemberKp = await generateKeypair();
    const newMemberPub = publicKeyFromPrivate(newMemberKp.privateKey);
    const ownerPub = publicKeyFromPrivate(ownerKp.privateKey);

    const contentKey = await randomKey();
    const ownerEnvelope = await sealEnvelope(contentKey, ownerPub, ownerKp);

    const cacheRoot = join(testRoot, "sandbox-cache");
    await writeCacheEntry(cacheRoot, "sb-grant-1", new Uint8Array([1, 2, 3]), {
      sandbox_id: "sb-grant-1",
      name: "x",
      description: null,
      owner_user_id: "owner-1",
      owner_x25519_pubkey_b64: Buffer.from(ownerPub).toString("base64"),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      ttl_days: 7,
      spec_json: null,
      sealed_envelope: {
        sealed_content_key_b64: Buffer.from(ownerEnvelope.ciphertext).toString("base64"),
        envelope_nonce_b64: Buffer.from(ownerEnvelope.nonce).toString("base64"),
      },
      pulled_at: new Date().toISOString(),
    });

    let grantPostBody: any = null;
    const apiClient = {
      get: async (path: string) => {
        if (path === "/v1/users/new-member-1/pubkey") {
          return {
            user_id: "new-member-1",
            x25519_pubkey: Buffer.from(newMemberPub).toString("base64"),
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path: string, body: any) => {
        if (path === "/v1/sandboxes/sb-grant-1/grants") {
          grantPostBody = body;
          return null;
        }
        throw new Error(`unexpected POST ${path}`);
      },
    } as any;

    await grantSandbox({
      apiClient,
      sandboxId: "sb-grant-1",
      newMemberUserId: "new-member-1",
      ownerKeypair: ownerKp,
    });

    expect(grantPostBody.envelopes).toHaveLength(1);
    const grantEnv = grantPostBody.envelopes[0];
    expect(grantEnv.user_id).toBe("new-member-1");

    const recovered = await openEnvelope(
      {
        ciphertext: Uint8Array.from(Buffer.from(grantEnv.sealed_content_key, "base64")),
        nonce: Uint8Array.from(Buffer.from(grantEnv.envelope_nonce, "base64")),
      },
      ownerPub,
      newMemberKp,
    );
    expect(recovered).toEqual(contentKey);
  });
});

describe("revokeSandbox", () => {
  it("calls DELETE on the right path", async () => {
    const calls: string[] = [];
    const apiClient = {
      delete: async (path: string) => {
        calls.push(path);
        return null;
      },
    } as any;
    await revokeSandbox({ apiClient, sandboxId: "sb-1", userId: "u-1" });
    expect(calls[0]).toBe("/v1/sandboxes/sb-1/grants/u-1");
  });
});

describe("listSandboxes", () => {
  it("forwards GET response", async () => {
    const apiClient = {
      get: async () => ({ sandboxes: [{ id: "a", role: "owner" }] }),
    } as any;
    const out = await listSandboxes({ apiClient });
    expect(out.sandboxes[0].id).toBe("a");
  });
});
