import {
  sealEnvelope,
  encryptBlob,
  decryptBlob,
  buildAad,
  FORMAT_V2,
  type Keypair,
  type Recipient,
} from "@veesker/engine";

export interface BuildResultForPublish {
  encryptedVsk: Uint8Array;
  contentKey: Uint8Array;
  sandboxName: string;
  ttlDays: number;
  memberUserIds: string[];
  specJson: unknown;
  description?: string;
}

export type UploadProgressCallback = (
  bytesUploaded: number,
  totalBytes: number,
) => void;

export interface PublishParams {
  apiClient: {
    get: <T = unknown>(path: string) => Promise<T>;
    post: (path: string, body: unknown, opts?: { idempotencyKey?: string }) => Promise<any>;
  };
  ownerKeypair: Keypair;
  ownerUserId: string;
  buildResult: BuildResultForPublish;
  uploader: (
    url: string,
    bytes: Uint8Array,
    onProgress?: UploadProgressCallback,
  ) => Promise<void>;
  idempotencyKey?: string;
  /** Called by the uploader as bytes leave the local pull cursor. Reported in
   *  bytes (not percentage) so the renderer can render any UI shape it likes
   *  — a percentage bar, a "X / Y MB" log line, or both. Driven by the
   *  ReadableStream pull cycle, so the report is "queued for network" not
   *  "acknowledged by R2"; for typical uploads the difference is the TCP
   *  send buffer (a few hundred KB at most). */
  onUploadProgress?: UploadProgressCallback;
}

export interface PublishResult {
  sandboxId: string;
}

interface CreateResponse {
  sandbox_id: string;
  upload_url: string;
  upload_expires_at: string;
  recipients: Array<{
    user_id: string;
    // Legacy field kept optional for backward compat with api < c4ecdf7.
    // After all desktop sidecars updated to >= d5633b2, api can strip and this falls back to GET.
    x25519_pubkey?: string;
  }>;
}

interface UserPubkeyResponse {
  user_id: string;
  x25519_pubkey: string;
}

const HEADER_SIZE_PUB = 64;

/**
 * Re-encrypt a FORMAT_V1 .vsk blob as FORMAT_V2 with AAD binding.
 * Parses the raw file bytes to extract the encrypted ciphertext, decrypts
 * with the known contentKey, then re-encrypts with canonical AAD built from
 * (sandboxId, sandboxVersion=1, recipientPubkey). Re-seals the owner
 * envelope with the same AAD. Returns new v2-format file bytes ready for R2.
 *
 * The sandboxId is only known after POST /v1/sandboxes returns — this
 * function is called at that point, before the upload, so the bytes that
 * land in R2 are always v2 for new publishes.
 */
export async function reencryptV1AsV2(
  fileBytes: Uint8Array,
  contentKey: Uint8Array,
  ownerKeypair: Keypair,
  sandboxId: string,
): Promise<Uint8Array> {
  // Use a fresh ArrayBuffer copy to avoid Buffer pool aliasing (byteOffset
  // on a pooled Buffer can place the view outside the parent buffer's length).
  const headerBuf = fileBytes.slice(0, HEADER_SIZE_PUB);
  const view = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
  const envelopeOffset = Number(view.getBigUint64(40, true));
  const envelopeLength = Number(view.getBigUint64(48, true));
  const dataOffset = Number(view.getBigUint64(24, true));
  const dataLength = Number(view.getBigUint64(32, true));

  const envelopeJson = new TextDecoder().decode(
    fileBytes.subarray(envelopeOffset, envelopeOffset + envelopeLength),
  );
  const meta = JSON.parse(envelopeJson) as {
    nonce: string;
    ciphertext: string;
    blobNonce: string;
    formatVersion?: number;
  };

  // v1 only — if caller somehow passes a v2 file, return as-is
  const existingFmt = meta.formatVersion ?? 1;
  if (existingFmt === FORMAT_V2) return fileBytes;

  const blobNonce = Uint8Array.from(Buffer.from(meta.blobNonce, "base64"));
  const encryptedCiphertext = fileBytes.subarray(dataOffset, dataOffset + dataLength);

  const plainBytes = await decryptBlob(contentKey, encryptedCiphertext, blobNonce);

  // sandboxVersion is always 1 on initial publish
  const sandboxVersion = 1;
  const recipientPubkey = ownerKeypair.publicKey;

  // Both blob and envelope use ownerKp.publicKey as the canonical recipientPubkey, matching engine writer contract.
  const aad = buildAad({ sandboxId, sandboxVersion, recipientPubkey, formatVersion: FORMAT_V2 });

  const encrypted = await encryptBlob(contentKey, plainBytes, { aad });
  const ownerEnvelope = await sealEnvelope(contentKey, recipientPubkey, ownerKeypair, { aad });

  const newEnvelopeBlock: Record<string, string | number> = {
    nonce: Buffer.from(ownerEnvelope.nonce).toString("base64"),
    ciphertext: Buffer.from(ownerEnvelope.ciphertext).toString("base64"),
    blobNonce: Buffer.from(encrypted.nonce).toString("base64"),
    formatVersion: FORMAT_V2,
    sandboxId,
    sandboxVersion,
    recipientPubkey: Buffer.from(recipientPubkey).toString("base64"),
  };
  const newEnvelopeBytes = new TextEncoder().encode(JSON.stringify(newEnvelopeBlock));

  const newEnvelopeOffset = BigInt(HEADER_SIZE_PUB);
  const newEnvelopeLength = BigInt(newEnvelopeBytes.byteLength);
  const newDataOffset = newEnvelopeOffset + newEnvelopeLength;
  const newDataLength = BigInt(encrypted.ciphertext.byteLength);

  // Rebuild header with FORMAT_V2
  const newHeader = new Uint8Array(HEADER_SIZE_PUB);
  const newView = new DataView(newHeader.buffer);
  // Copy magic (bytes 0-3) and version (bytes 4-5) from original
  newView.setUint32(0, view.getUint32(0, false), false);
  newView.setUint16(4, view.getUint16(4, true), true);
  newView.setUint16(6, FORMAT_V2, true);
  newView.setBigUint64(8, 0n, true);  // manifestOffset = 0
  newView.setBigUint64(16, 0n, true); // manifestLength = 0
  newView.setBigUint64(24, newDataOffset, true);
  newView.setBigUint64(32, newDataLength, true);
  newView.setBigUint64(40, newEnvelopeOffset, true);
  newView.setBigUint64(48, newEnvelopeLength, true);
  newView.setBigUint64(56, 0n, true); // reserved

  const total = HEADER_SIZE_PUB + newEnvelopeBytes.byteLength + encrypted.ciphertext.byteLength;
  const out = new Uint8Array(total);
  out.set(newHeader, 0);
  out.set(newEnvelopeBytes, HEADER_SIZE_PUB);
  out.set(encrypted.ciphertext, HEADER_SIZE_PUB + newEnvelopeBytes.byteLength);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function publishSandbox(params: PublishParams): Promise<PublishResult> {
  const { apiClient, ownerKeypair, ownerUserId, buildResult, uploader, idempotencyKey } = params;

  const create: CreateResponse = await apiClient.post(
    "/v1/sandboxes",
    {
      name: buildResult.sandboxName,
      description: buildResult.description,
      ttl_days: buildResult.ttlDays,
      member_user_ids: buildResult.memberUserIds,
      spec_json: buildResult.specJson,
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );

  // Fetch each recipient's pubkey. Owner pubkey comes from the local keypair
  // (no round trip needed). For members, use x25519_pubkey from the create
  // response if present (old api path); otherwise fetch via GET (new api path
  // after API-S-008 strip). Member fetches run in parallel to keep latency low.
  const recipients: Recipient[] = await Promise.all(
    create.recipients.map(async (r) => {
      if (r.user_id === ownerUserId) {
        return { userId: r.user_id, x25519Pubkey: ownerKeypair.publicKey };
      }
      if (r.x25519_pubkey) {
        return {
          userId: r.user_id,
          x25519Pubkey: Uint8Array.from(Buffer.from(r.x25519_pubkey, "base64")),
        };
      }
      // TODO(cross-org/Plan 11): GET /v1/users/:user_id/pubkey enforces same-org-only.
      // Cross-org sandbox publishing will require a scope relaxation similar to
      // Plan 11's sandbox-membership endpoint.
      const resp = await apiClient.get<UserPubkeyResponse>(
        `/v1/users/${r.user_id}/pubkey`,
      );
      return {
        userId: r.user_id,
        x25519Pubkey: Uint8Array.from(Buffer.from(resp.x25519_pubkey, "base64")),
      };
    }),
  );

  // Re-encrypt the pre-built v1 blob as v2 now that sandboxId is known.
  // sandboxVersion = 1 for initial publish; the owner pubkey acts as the
  // canonical recipientPubkey in the AAD shared across all envelopes.
  const v2Bytes = await reencryptV1AsV2(
    buildResult.encryptedVsk,
    buildResult.contentKey,
    ownerKeypair,
    create.sandbox_id,
  );

  // Build the AAD that binds all envelopes to this sandbox identity.
  // The embedded owner envelope JSON stores recipientPubkey = ownerPub,
  // so both owner and member envelopes must use the same AAD so that
  // readEncryptedVsk can reconstruct it from the embedded envelope block.
  const sharedAad = buildAad({
    sandboxId: create.sandbox_id,
    sandboxVersion: 1,
    recipientPubkey: ownerKeypair.publicKey,
    formatVersion: FORMAT_V2,
  });

  // Seal per-recipient envelopes with the shared AAD so members can
  // also decrypt via openEnvelope(..., { aad: sharedAad }).
  const sealed: Array<{ userId: string; envelope: { ciphertext: Uint8Array; nonce: Uint8Array } }> = [];
  for (const r of recipients) {
    if (r.x25519Pubkey.length !== 32) {
      throw new Error(`x25519Pubkey must be 32 bytes, got ${r.x25519Pubkey.length} for userId=${r.userId}`);
    }
    const env = await sealEnvelope(buildResult.contentKey, r.x25519Pubkey, ownerKeypair, { aad: sharedAad });
    sealed.push({ userId: r.userId, envelope: env });
  }

  await uploader(create.upload_url, v2Bytes, params.onUploadProgress);

  const blobSha = await sha256Hex(v2Bytes);

  await apiClient.post(
    `/v1/sandboxes/${create.sandbox_id}/finalize`,
    {
      envelopes: sealed.map((s) => ({
        user_id: s.userId,
        sealed_content_key: Buffer.from(s.envelope.ciphertext).toString("base64"),
        envelope_nonce: Buffer.from(s.envelope.nonce).toString("base64"),
      })),
      blob_size_bytes: v2Bytes.length,
      blob_sha256_hex: blobSha,
    },
  );

  return { sandboxId: create.sandbox_id };
}

/** Tunable so tests can exercise the chunked path against small fixtures.
 *  64 KiB matches a typical TCP send window — small enough that even small
 *  uploads emit a few progress ticks, large enough that the per-chunk
 *  overhead (one ReadableStream pull + one onProgress call) is negligible
 *  next to the network write. Tests can override via the test-only setter
 *  below to avoid building multi-MB fixtures just to cross the threshold. */
let UPLOAD_CHUNK_BYTES = 64 * 1024;

/** TEST ONLY: lower the chunk size so unit tests can drive the streaming
 *  path with small fixtures. Production code never calls this — leaving
 *  UPLOAD_CHUNK_BYTES as a `let` is harmless because the value is read on
 *  every uploadViaFetch call, so a test override is scoped to the test
 *  process and can't leak into a sidecar binary. */
export function setUploadChunkBytesForTesting(bytes: number): void {
  UPLOAD_CHUNK_BYTES = bytes;
}
export function resetUploadChunkBytesForTesting(): void {
  UPLOAD_CHUNK_BYTES = 64 * 1024;
}

export async function uploadViaFetch(
  url: string,
  bytes: Uint8Array,
  onProgress?: UploadProgressCallback,
): Promise<void> {
  const total = bytes.byteLength;

  // Without a progress sink, or for payloads small enough that chunking
  // would be all overhead, fall through to the simple non-streaming PUT.
  if (!onProgress || total <= UPLOAD_CHUNK_BYTES) {
    const res = await fetch(url, { method: "PUT", body: bytes });
    if (!res.ok) throw new Error(`R2 PUT failed with HTTP ${res.status}`);
    onProgress?.(total, total);
    return;
  }

  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const end = Math.min(sent + UPLOAD_CHUNK_BYTES, total);
      // subarray reuses the parent buffer — the upload only reads bytes
      // through the stream and never mutates them, so the shared view is
      // safe and avoids per-chunk copies. The parent ArrayBuffer is held
      // by the caller frames anyway (buildResult.encryptedVsk + the
      // closure capture below), so a slice copy would just inflate peak
      // RSS without unblocking GC.
      controller.enqueue(bytes.subarray(sent, end));
      sent = end;
      onProgress(sent, total);
    },
  });

  const res = await fetch(url, {
    method: "PUT",
    body: stream,
    headers: { "Content-Length": String(total) },
    // Streaming request bodies require duplex: "half" in WHATWG fetch. Bun
    // supports this; node-fetch / undici environments may need a polyfill,
    // but the sidecar always runs under Bun.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) throw new Error(`PUT ${url} → ${res.status}`);
}
