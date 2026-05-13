import {
  sealForRecipients,
  openEnvelope,
  pubkeyFromBase64,
  type Keypair,
  type Envelope,
} from "@veesker/engine";
import { readCacheEntry, resolveSandboxCacheDir } from "./cache";

export interface GrantParams {
  apiClient: {
    get: <T = unknown>(path: string) => Promise<T>;
    post: (path: string, body: unknown) => Promise<any>;
  };
  sandboxId: string;
  newMemberUserId: string;
  ownerKeypair: Keypair;
}

export async function grantSandbox(params: GrantParams): Promise<void> {
  const cacheRoot = resolveSandboxCacheDir();
  const { meta } = await readCacheEntry(cacheRoot, params.sandboxId);

  const ownerPub = pubkeyFromBase64(meta.owner_x25519_pubkey_b64);
  const ownerEnvelope: Envelope = {
    ciphertext: new Uint8Array(
      Buffer.from(meta.sealed_envelope.sealed_content_key_b64, "base64"),
    ),
    nonce: new Uint8Array(
      Buffer.from(meta.sealed_envelope.envelope_nonce_b64, "base64"),
    ),
  };
  const contentKey = await openEnvelope(ownerEnvelope, ownerPub, params.ownerKeypair);

  try {
    const pubResp = await params.apiClient.get<{ user_id: string; x25519_pubkey: string }>(
      `/v1/users/${params.newMemberUserId}/pubkey`,
    );
    const newPub = Uint8Array.from(Buffer.from(pubResp.x25519_pubkey, "base64"));

    const sealed = await sealForRecipients(
      contentKey,
      [{ userId: params.newMemberUserId, x25519Pubkey: newPub }],
      params.ownerKeypair,
    );

    await params.apiClient.post(`/v1/sandboxes/${params.sandboxId}/grants`, {
      envelopes: sealed.map((s) => ({
        user_id: s.userId,
        sealed_content_key: Buffer.from(s.envelope.ciphertext).toString("base64"),
        envelope_nonce: Buffer.from(s.envelope.nonce).toString("base64"),
      })),
    });
  } finally {
    contentKey.fill(0);
  }
}

export interface RevokeParams {
  apiClient: { delete: (path: string) => Promise<any> };
  sandboxId: string;
  userId: string;
}

export async function revokeSandbox(params: RevokeParams): Promise<void> {
  await params.apiClient.delete(`/v1/sandboxes/${params.sandboxId}/grants/${params.userId}`);
}

export interface ListParams {
  apiClient: { get: <T = unknown>(path: string) => Promise<T> };
}

export interface ListResponse {
  sandboxes: Array<{
    id: string;
    name: string;
    status: string;
    role: "owner" | "member";
    owner_user_id: string;
    expires_at: string;
    created_at: string;
    finalized_at: string | null;
    blob_size_bytes: number | null;
  }>;
}

export async function listSandboxes(params: ListParams): Promise<ListResponse> {
  return await params.apiClient.get<ListResponse>("/v1/sandboxes");
}
