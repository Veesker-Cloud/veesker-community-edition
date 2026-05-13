import { unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyJwtClaims } from "./jwt-verify";
import {
  OsKeyringStore,
  sodiumReady,
  publicKeyFromPrivate,
  generateKeypair,
  openEnvelope,
  type Keypair,
  type KeyStore,
} from "@veesker/engine";
import { ApiClient } from "../api/client";
import { readVskAtomic } from "./read-vsk-atomic";
import { validateOutPath } from "./validate-out-path";
import { sweepStaleBuilds, type SweepResult } from "./sweep-builds";
import { publishSandbox, uploadViaFetch, reencryptV1AsV2 } from "./publish";
import { pullSandbox, downloadViaFetch } from "./pull";
import { grantSandbox, revokeSandbox, listSandboxes } from "./grant";
import { openSandbox } from "./open";
import { startRevokeWatch } from "./revoke-watch";
import { querySandbox } from "./query";
import { closeSandbox } from "./close";
import { listCachedSandboxes } from "./list-cached";
import { deleteSandbox } from "./delete";
import { leaveSandbox } from "./leave";
import type { LastSeenStore } from "./last-seen";
import { saveBuildConfig, type SandboxBuildConfig } from "./build-config-store";
import { handleSandboxRepublish, type RepublishEnv } from "./republish";
import { makeProductionBuildEnv, buildSandbox } from "../sandbox/build";
import type { SandboxBuildSpec } from "../sandbox/types";

export interface SandboxRpcEnvelope {
  apiBaseUrl: string;
  apiToken: string;
  ownerAccount: string;
  ownerUserId: string;
}

/** Inbound shape of the cloud envelope after the Rust-side cleanup
 *  (commands.rs::inject_cloud_envelope): the renderer no longer carries
 *  identity claims at all — they are derived inside the sidecar from the
 *  JWT we receive in apiToken. ownerAccount/ownerUserId remain part of
 *  SandboxRpcEnvelope (above) so existing handler code reads from one
 *  consistent shape; expandSandboxEnvelope normalizes the inbound payload. */
interface InboundSandboxParams {
  apiBaseUrl?: string;
  apiToken: string;
  ownerAccount?: string;
  ownerUserId?: string;
}

export interface SandboxPublishHandlerParams extends InboundSandboxParams {
  outPath: string;
  expectedBuildsDir: string;
  sandboxName: string;
  ttlDays: number;
  memberUserIds: string[];
  specJson: unknown;
  description?: string;
  idempotencyKey?: string;
  /** Plan 7: optional build config snapshot. When provided, sidecar persists
   *  it to <expectedBuildsDir>/<sandbox_id>.config.json after successful
   *  publish so a future republish can reuse the same source picks. The frontend
   *  wizard supplies this on initial publish; absent for legacy or programmatic
   *  callers — in which case republish will not be possible from this machine. */
  buildConfig?: Omit<SandboxBuildConfig, "sandboxId">;
}

const DEFAULT_API_BASE_URL = "https://api.veesker.cloud";

/** Normalize an inbound sandbox.* RPC payload into the SandboxRpcEnvelope
 *  shape every handler expects. The Rust shell injects apiToken (from the OS
 *  keychain) + apiBaseUrl; identity (ownerAccount = email, ownerUserId = sub)
 *  is derived from cryptographically verified JWT claims via JWKS fetch.
 *  If a renderer ever supplies ownerAccount/ownerUserId they are IGNORED in
 *  favor of the JWT-derived values — defense-in-depth.
 *
 *  Throws if apiToken is missing/malformed, signature verification fails,
 *  algorithm is not ES256, issuer is not "veesker-cloud", or required claims
 *  (sub, email) are absent. */
export async function expandSandboxEnvelope<T extends InboundSandboxParams>(
  params: T,
): Promise<T & SandboxRpcEnvelope> {
  const apiBaseUrl = params.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const claims = await verifyJwtClaims(params.apiToken, apiBaseUrl);
  return {
    ...params,
    apiToken: params.apiToken,
    apiBaseUrl,
    ownerAccount: claims.email,
    ownerUserId: claims.sub,
  };
}

const KEYSTORE_SERVICE = "veesker-engine";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadKeypair(
  account: string,
  override?: KeyStore,
): Promise<Keypair> {
  await sodiumReady();
  const store = override ?? new OsKeyringStore(KEYSTORE_SERVICE, account);
  const privateKey = await store.getPrivateKey();
  if (!privateKey) {
    throw new Error(`No keypair found in keystore for account=${account}`);
  }
  const publicKey = publicKeyFromPrivate(privateKey);
  return { publicKey, privateKey };
}

export interface SandboxPublishHandlerOptions {
  keystore?: KeyStore;
  /** Optional notification sink. When provided the publish handler emits
   *  `sandbox.upload-progress` notifications during the R2 PUT, carrying
   *  `{ bytesUploaded, totalBytes }`. The renderer can subscribe to the
   *  forwarded `sandbox-upload-progress` Tauri event to render a live
   *  progress bar. Optional so the unit-test suite can omit it. */
  dispatchNotification?: (n: { method: string; params: unknown }) => void;
}

export async function handleSandboxPublish(
  rawParams: SandboxPublishHandlerParams,
  opts: SandboxPublishHandlerOptions = {},
) {
  const params = await expandSandboxEnvelope(rawParams);
  await validateOutPath(params.outPath, params.expectedBuildsDir);

  const ownerKp = await loadKeypair(params.ownerAccount, opts.keystore);
  const { envelope, fileBytes } = await readVskAtomic(params.outPath);

  const dispatch = opts.dispatchNotification;
  const onUploadProgress = dispatch
    ? (bytesUploaded: number, totalBytes: number) => {
        dispatch({
          method: "sandbox.upload-progress",
          params: {
            sandboxName: params.sandboxName,
            bytesUploaded,
            totalBytes,
          },
        });
      }
    : undefined;

  let contentKey: Uint8Array | null = null;
  try {
    contentKey = await openEnvelope(envelope, ownerKp.publicKey, ownerKp);

    const client = new ApiClient({
      baseUrl: params.apiBaseUrl,
      token: params.apiToken,
    });
    const result = await publishSandbox({
      apiClient: client,
      ownerKeypair: ownerKp,
      ownerUserId: params.ownerUserId,
      buildResult: {
        encryptedVsk: fileBytes,
        contentKey,
        sandboxName: params.sandboxName,
        ttlDays: params.ttlDays,
        memberUserIds: params.memberUserIds,
        specJson: params.specJson,
        description: params.description,
      },
      uploader: uploadViaFetch,
      onUploadProgress,
      idempotencyKey: params.idempotencyKey,
    });
    // Plan 7: persist build config alongside (post-unlink) sandbox-builds dir
    // so future republish can re-run the same build pipeline. Best-effort:
    // a save failure should not break a successful publish.
    if (params.buildConfig) {
      try {
        await saveBuildConfig(params.expectedBuildsDir, {
          ...params.buildConfig,
          sandboxId: result.sandboxId,
        });
      } catch (err) {
        process.stderr.write(
          `[plan7] failed to persist build config: ${(err as Error).message}\n`,
        );
      }
    }
    // R2 holds the official copy now; the local build artifact in
    // app_data/sandbox-builds/ has served its purpose. Best-effort delete:
    // a stray .vsk left here doesn't hurt correctness, only disk usage.
    await unlink(params.outPath).catch(() => {
      /* best effort */
    });
    return result;
  } finally {
    contentKey?.fill(0);
  }
}

/** Plan 7 production wiring for sandbox.republish.
 *  Composes a real RepublishEnv from the OS keychain (owner keypair),
 *  the Veesker Cloud API (envelope fetch, R2 url request, finalize),
 *  the existing build pipeline (oracledb extraction + DuckDB pack +
 *  encrypt with REUSED contentKey), and the existing uploader
 *  (uploadViaFetch). Reusing the contentKey is the whole point of the
 *  republish path — prior recipient envelopes still decrypt to the
 *  same symmetric key, so the .vsk blob can be replaced without
 *  re-sealing N member envelopes. */
interface RepublishProductionParams extends InboundSandboxParams {
  sandboxId: string;
  oracleConfig: { user: string; password: string; connectString: string };
  expectedBuildsDir: string;
}

interface ApiSandboxResponse {
  sandbox: {
    id: string;
    owner_user_id: string;
    name: string;
  };
  sealed_envelope: {
    sealed_content_key: string;
    envelope_nonce: string;
  };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function handleSandboxRepublishProduction(
  rawParams: RepublishProductionParams,
): Promise<{ ok: true; new_blob_sha256: string; bytes: number }> {
  const params = await expandSandboxEnvelope(rawParams);
  const sandboxId = rawParams.sandboxId;
  if (typeof sandboxId !== "string" || sandboxId.length === 0) {
    throw new Error("sandbox.republish requires sandboxId");
  }
  if (!UUID_RE.test(sandboxId)) {
    throw new Error("sandbox.republish: invalid sandboxId (expected UUID)");
  }
  const oracleConfig = rawParams.oracleConfig;
  if (
    !oracleConfig ||
    typeof oracleConfig !== "object" ||
    typeof (oracleConfig as { user?: unknown }).user !== "string" ||
    typeof (oracleConfig as { password?: unknown }).password !== "string" ||
    typeof (oracleConfig as { connectString?: unknown }).connectString !== "string"
  ) {
    throw new Error(
      "sandbox.republish requires oracleConfig with user/password/connectString",
    );
  }
  if (
    typeof rawParams.expectedBuildsDir !== "string" ||
    rawParams.expectedBuildsDir.length === 0
  ) {
    throw new Error("sandbox.republish requires expectedBuildsDir");
  }

  await sodiumReady();
  const apiClient = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });

  // Fetch existing envelope + canonical sandbox name from the API.
  // The same endpoint pull uses returns the owner self-seal envelope
  // when the caller's JWT.sub matches owner_user_id (v1 single-recipient
  // model); republish is owner-only so this is always the case.
  const sbResp = await apiClient.get<ApiSandboxResponse>(
    `/v1/sandboxes/${sandboxId}`,
  );

  // Recover owner keypair from OS keychain. Republish CANNOT auto-provision
  // a fresh keypair the way initial publish does — a new keypair would not
  // decrypt the existing envelope, breaking access for prior recipients.
  // If the keychain entry is missing the operation MUST abort.
  const store = new OsKeyringStore(KEYSTORE_SERVICE, params.ownerAccount);
  const priv = await store.getPrivateKey();
  if (!priv) {
    throw new Error(
      `sandbox.republish: no owner keypair found in keychain for ${params.ownerAccount} — cannot decrypt existing envelope`,
    );
  }
  const ownerKp: Keypair = {
    publicKey: publicKeyFromPrivate(priv),
    privateKey: priv,
  };

  // Captured from recoverContentKey so uploadToR2 can re-encrypt with AAD.
  // handleSandboxRepublish calls recoverContentKey before buildSandbox and
  // uploadToR2, so this is always populated by the time upload runs.
  let capturedContentKey: Uint8Array | null = null;

  const env: RepublishEnv = {
    buildsDir: rawParams.expectedBuildsDir,
    recoverContentKey: async () => {
      const envelope = {
        ciphertext: Uint8Array.from(
          Buffer.from(sbResp.sealed_envelope.sealed_content_key, "base64"),
        ),
        nonce: Uint8Array.from(
          Buffer.from(sbResp.sealed_envelope.envelope_nonce, "base64"),
        ),
      };
      // Self-seal: senderPub === ownerKp.publicKey (same identity for
      // both ends of the ECDH). Matches build.ts sealEnvelopeForOwner.
      const ck = await openEnvelope(envelope, ownerKp.publicKey, ownerKp);
      capturedContentKey = ck;
      return ck;
    },
    oracleConfigResolver: async () => oracleConfig,
    buildSandbox: async (specObj, contentKey) => {
      const buildEnv = makeProductionBuildEnv(oracleConfig, {
        existingContentKey: contentKey,
        ownerKp,
      });
      const outPath = join(
        rawParams.expectedBuildsDir,
        `${sandboxId}-republish.vsk`,
      );
      const fullSpec: SandboxBuildSpec = {
        ...(specObj as Partial<SandboxBuildSpec> & {
          connectionId: string;
          schemaName: string;
          primaryTables: SandboxBuildSpec["primaryTables"];
          ttlDays: number;
          piiLevel: 0 | 1 | 2;
        }),
        sandboxName: sbResp.sandbox.name,
        ownerAccount: params.ownerAccount,
        outPath,
        dryRun: false,
      };
      const result = await buildSandbox(fullSpec, buildEnv, () => {
        // Plan 5d streaming progress is publish-only; republish runs
        // synchronously without progress notifications for now.
      });
      return { outPath: result.outPath, totalRows: result.totalRows };
    },
    requestRepublishUrl: async (sbId) =>
      apiClient.post<{ upload_url: string; blob_key: string; expires_in: number }>(
        `/v1/sandboxes/${sbId}/republish`,
        {},
      ),
    uploadToR2: async (vskPath, uploadUrl) => {
      const buf = await readFile(vskPath);
      let u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      // sandboxVersion is baked into the .vsk file's AAD at build time and is not bumped on republish.
      // Reader reconstructs AAD from the envelope JSON, so version=1 is consistent across initial publish and republishes.
      try {
        if (capturedContentKey) {
          u8 = await reencryptV1AsV2(u8, capturedContentKey, ownerKp, sandboxId);
        }
        await uploadViaFetch(uploadUrl, u8);
        const sha = await sha256HexBytes(u8);
        // Best-effort cleanup: a stray republish .vsk on disk is harmless,
        // only inflates app_data. Don't fail the operation if unlink errors.
        await unlink(vskPath).catch(() => {
          /* best effort */
        });
        return { sha256: sha, size: u8.byteLength };
      } finally {
        capturedContentKey?.fill(0);
      }
    },
    finalizeRepublish: async (sbId, body) => {
      await apiClient.post(`/v1/sandboxes/${sbId}/republish/finalize`, body);
      return { ok: true as const };
    },
  };

  return await handleSandboxRepublish({ sandboxId }, env);
}

export async function handleSandboxPull(
  rawParams: InboundSandboxParams & { sandboxId: string },
) {
  const params = await expandSandboxEnvelope(rawParams);
  const client = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  return await pullSandbox({
    apiClient: client,
    sandboxId: params.sandboxId,
    downloader: downloadViaFetch,
  });
}

export async function handleSandboxGrant(
  rawParams: InboundSandboxParams & {
    sandboxId: string;
    newMemberUserId: string;
  },
) {
  const params = await expandSandboxEnvelope(rawParams);
  const client = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  const kp = await loadKeypair(params.ownerAccount);
  await grantSandbox({
    apiClient: client,
    sandboxId: params.sandboxId,
    newMemberUserId: params.newMemberUserId,
    ownerKeypair: kp,
  });
  return { ok: true };
}

export async function handleSandboxRevoke(
  rawParams: InboundSandboxParams & { sandboxId: string; userId: string },
) {
  const params = await expandSandboxEnvelope(rawParams);
  const client = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  await revokeSandbox({
    apiClient: client,
    sandboxId: params.sandboxId,
    userId: params.userId,
  });
  return { ok: true };
}

export interface SandboxListHandlerOptions {
  /** Optional store for the per-account last-seen ids. When provided, the
   *  response includes a top-level `lastSeenIds: string[]` so the renderer
   *  can render the unread/new dot for sandboxes the user has never opened
   *  in this device's UI. Optional so tests can omit it. */
  lastSeenStore?: LastSeenStore;
}

export async function handleSandboxList(
  rawParams: InboundSandboxParams,
  opts: SandboxListHandlerOptions = {},
) {
  const params = await expandSandboxEnvelope(rawParams);
  const client = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  const apiResponse = await listSandboxes({ apiClient: client });

  let lastSeenIds: string[] = [];
  if (opts.lastSeenStore) {
    try {
      lastSeenIds = await opts.lastSeenStore.loadLastSeenIds();
    } catch {
      // best effort: a missing/corrupt last-seen file must never block list
      lastSeenIds = [];
    }
  }

  return {
    ...apiResponse,
    lastSeenIds,
  };
}

export async function handleSandboxLeave(
  rawParams: InboundSandboxParams & { sandboxId: string },
) {
  const params = await expandSandboxEnvelope(rawParams);
  if (typeof params.sandboxId !== "string" || params.sandboxId.length === 0) {
    throw new Error("sandboxId is required");
  }
  const client = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  return await leaveSandbox({
    apiClient: client,
    sandboxId: params.sandboxId,
    currentUserId: params.ownerUserId,
  });
}

export async function handleSandboxDelete(
  rawParams: InboundSandboxParams & { sandboxId: string },
) {
  const params = await expandSandboxEnvelope(rawParams);
  if (typeof params.sandboxId !== "string" || params.sandboxId.length === 0) {
    throw new Error("sandboxId is required");
  }
  const client = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  return await deleteSandbox({
    apiClient: client,
    sandboxId: params.sandboxId,
  });
}

export async function handleSandboxOpen(
  rawParams: InboundSandboxParams & { sandboxId: string },
  dispatchNotification: (n: { method: string; params: unknown }) => void,
) {
  const params = await expandSandboxEnvelope(rawParams);
  const keystore = new OsKeyringStore(KEYSTORE_SERVICE, params.ownerAccount);
  const result = await openSandbox({
    sandboxId: params.sandboxId,
    keystore,
  });

  const apiClient = new ApiClient({
    baseUrl: params.apiBaseUrl,
    token: params.apiToken,
  });
  queueMicrotask(() => {
    startRevokeWatch({
      sandboxId: params.sandboxId,
      apiClient,
      dispatchNotification,
    }).catch(() => {
      /* swallow — watcher is best-effort */
    });
  });

  return result;
}

export async function handleSandboxQuery(params: { sandboxId: string; sql: string }) {
  return await querySandbox({ sandboxId: params.sandboxId, sql: params.sql });
}

export async function handleSandboxClose(params: { sandboxId: string }) {
  return await closeSandbox({ sandboxId: params.sandboxId });
}

export async function handleSandboxListCached(rawParams: InboundSandboxParams) {
  // The renderer always wraps sandbox.* calls in the cloud envelope (apiToken
  // injected by Rust). We read the JWT-derived currentUserId so we can tag
  // each cached row with role=owner|member without re-hitting the API.
  const params = await expandSandboxEnvelope(rawParams);
  const result = await listCachedSandboxes();
  return {
    sandboxes: result.sandboxes.map((row) => ({
      ...row,
      role: row.owner_user_id === params.ownerUserId ? "owner" : "member",
    })),
  };
}

export interface SandboxSweepBuildsParams {
  buildsDir: string;
  /** Defaults to 7 days. */
  maxAgeDays?: number;
}

/** JSON-RPC `sandbox.sweep-builds`. Best-effort cleanup of stale `.vsk`
 *  files (publish failures, old aborted runs) in app_data/sandbox-builds/.
 *  The successful publish path already auto-deletes its own artifact —
 *  this sweep is for everything that slipped through.
 *
 *  buildsDir comes from the renderer; sweepStaleBuilds rejects any path
 *  that does not end in 'sandbox-builds' to keep a compromised renderer
 *  from asking the sidecar to wipe arbitrary directories. The Tauri shell
 *  injects the canonical path, so legitimate calls always pass. */
export async function handleSandboxSweepBuilds(
  params: SandboxSweepBuildsParams,
): Promise<SweepResult> {
  const maxAgeDays = params.maxAgeDays ?? 7;
  return await sweepStaleBuilds(params.buildsDir, maxAgeDays);
}

export interface EnsureKeypairOptions {
  keystore?: KeyStore;
  apiPut?: (path: string, body: unknown) => Promise<unknown>;
}

export async function handleSandboxEnsureKeypair(
  rawParams: InboundSandboxParams,
  opts: EnsureKeypairOptions = {},
): Promise<{ pubkey_b64: string; registered_at: string; just_registered: boolean }> {
  const params = await expandSandboxEnvelope(rawParams);
  await sodiumReady();
  const keystore = opts.keystore ?? new OsKeyringStore(KEYSTORE_SERVICE, params.ownerAccount);

  const apiPut = opts.apiPut ?? (async (path: string, body: unknown) => {
    const client = new ApiClient({ baseUrl: params.apiBaseUrl, token: params.apiToken });
    return await client.put(path, body);
  });

  const existing = await keystore.getPrivateKey();
  let pubkeyB64: string;
  let just_registered: boolean;

  if (existing) {
    pubkeyB64 = Buffer.from(publicKeyFromPrivate(existing)).toString("base64");
    just_registered = false;
  } else {
    const kp = await generateKeypair();
    await keystore.setPrivateKey(kp.privateKey);
    pubkeyB64 = Buffer.from(kp.publicKey).toString("base64");
    just_registered = true;
  }

  const response = await apiPut("/v1/users/me/pubkey", { x25519_pubkey: pubkeyB64 }) as { x25519_pubkey: string; registered_at: string };

  return {
    pubkey_b64: pubkeyB64,
    registered_at: response.registered_at,
    just_registered,
  };
}
