// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { invoke } from "@tauri-apps/api/core";

export interface SandboxSummary {
  sandbox_id: string;
  name: string;
  owner_user_id: string;
  blob_size_bytes: number;
  pulled_at?: string;
  expires_at: string;
  status: "ready" | "expired" | "deleted";
  cached: boolean;
  role: "owner" | "member";
  /** Plan 7: SHA-256 of the current blob on R2. Members compare to their
   *  cached value to detect republish (owner refreshed data). Optional
   *  because older API versions may not include it; new server always does. */
  blob_sha256?: string;
  /** Plan 7: increments on each republish. Initial publish is 1. */
  published_version_count?: number;
}

export interface OpenSandboxColumn {
  table_name: string;
  name: string;
  type: string;
  nullable: boolean;
}

export interface OpenSandboxSkippedObject {
  kind: string;
  owner: string;
  name: string;
  reason: string;
  detail?: string;
}

export interface OpenSandboxResult {
  sandbox_id: string;
  tables: string[];
  columns: OpenSandboxColumn[];
  opened_at: string;
  status: "open";
  skippedObjects?: OpenSandboxSkippedObject[];
}

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  row_count: number;
  elapsed_ms: number;
}

export interface EnsureKeypairResult {
  pubkey_b64: string;
  registered_at: string;
  just_registered: boolean;
}

export interface PullSandboxResult {
  sandbox_id: string;
  name: string;
  status: "ready" | "expired" | "deleted";
  blob_size_bytes: number;
  pulled_at: string;
  cached: true;
}

export interface CloseSandboxResult {
  sandbox_id: string;
  status: "closed";
}

// ─── Plan 5b — Owner publish wizard types ──────────────────────────────────

/** Resolved Oracle credentials for a one-shot wizard RPC. The wizard caller
 *  resolves these via the existing CL connection store before invoking any of
 *  the Plan 5b wrappers below. The sidecar opens a fresh connection per RPC
 *  (matching the sandbox.build pattern) — no session re-use. */
export interface SandboxOracleConfig {
  user: string;
  password: string;
  connectString: string;
}

/** One row of `sandbox.list-schema-tables`. `rowCount` and `sizeBytesEst`
 *  may be null when stats are missing or the user can't see USER_SEGMENTS. */
export interface SchemaTableInfo {
  name: string;
  rowCount: number | null;
  sizeBytesEst: number | null;
}

export interface FkClosureEntryEdge {
  fromTable: string;
  fromColumns: string[];
  toColumns: string[];
}

export interface FkClosureEntry {
  name: string;
  /** 0 = explicit primary table, N = N-th FK hop. */
  depth: number;
  viaFk?: FkClosureEntryEdge;
}

export interface FkEdge {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

export interface FkClosureResult {
  entries: FkClosureEntry[];
  edges: FkEdge[];
}

export interface PiiSuggestion {
  table: string;
  column: string;
  signal: "column-name" | "sample-value" | "both";
  category: string;
  suggestedMask: string;
  confidence: number;
}

export interface PrimaryTableSpec {
  name: string;
  whereClause?: string;
  rowCap?: number;
}

/** Spec the wizard hands to a dry-run / publish call. Mirrors the sidecar's
 *  SandboxBuildSpec but the wrapper injects `dryRun` + `outPath` for the
 *  preview pass — the wizard doesn't set them. */
export interface PublishSandboxBuildSpec {
  connectionId: string;
  schemaName: string;
  sandboxName: string;
  ttlDays: number;
  piiLevel: 0 | 1 | 2;
  primaryTables: PrimaryTableSpec[];
  fkWalkDepth?: number;
  excludedPlsql?: Array<{ kind: string; owner: string; name: string }>;
}

/** Dry-run "done" event payload, surfaced via the sidecar event log. */
export interface DryRunDoneEvent {
  phase: "dry-run-done";
  fkClosureTables: string[];
  piiSuggestions: PiiSuggestion[];
  estimatedSizeBytes: number;
  estimatedTotalRows: number;
}

export type BuildProgressEvent =
  | { phase: "starting"; spec: { sandboxName: string; primaryTableCount: number } }
  | { phase: "introspecting-schema"; tables: string[] }
  | { phase: "fk-walking"; depthLevel: number; tablesAdded: string[] }
  | { phase: "pii-scanning"; tablesScanned: number; suggestionsCount: number }
  | DryRunDoneEvent
  | { phase: "extracting"; table: string; rowCount: number }
  | { phase: "packing-vsk"; bytes: number }
  | { phase: "encrypting"; recipientCount: number }
  | { phase: "done"; outPath: string; totalRows: number; manifest: unknown }
  | { phase: "error"; message: string; code?: string };

export interface SandboxBuildResponse {
  result: {
    outPath: string;
    totalRows: number;
    tableCount: number;
    piiSuggestionsApplied: number;
    ttlExpiresAt: string;
  };
  events: BuildProgressEvent[];
}

export interface UserLookupResult {
  userId: string;
  x25519Pubkey: string;
  registeredAt: string;
}

const API_BASE_URL = "https://api.veesker.cloud";

async function getAuthToken(): Promise<string | null> {
  try {
    return await invoke<string | null>("auth_token_get");
  } catch {
    return null;
  }
}

/**
 * Send a sandbox.* RPC. The renderer no longer carries identity claims
 * (apiToken / apiBaseUrl / ownerAccount / ownerUserId) — the Rust shell
 * injects apiToken from the OS keychain via inject_cloud_envelope and the
 * sidecar derives ownerAccount/ownerUserId from the JWT inside
 * expandSandboxEnvelope. This closes the previous attack surface where a
 * compromised renderer (XSS, malicious dependency) could call
 * sandbox.open with `ownerAccount="other-user"` to load a sibling
 * account's keypair.
 */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    // Tauri command rejections come back as { code: number, message: string }
    // (our ConnectionTestErr / RpcError shape). Sidecar JSON-RPC errors have
    // the same shape. Surface the message directly instead of stringifying
    // the object (which produces "[object Object]").
    const obj = e as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "number" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

async function rpc<T>(
  command: string,
  params: object = {},
): Promise<T> {
  try {
    return await invoke<T>(command, { payload: { ...params } });
  } catch (e) {
    console.error(`[sandbox.rpc] ${command} failed:`, e);
    throw new Error(`${command}: ${describeError(e)}`);
  }
}

export async function ensureSandboxKeypair(): Promise<EnsureKeypairResult> {
  return await rpc<EnsureKeypairResult>("sandbox_ensure_keypair");
}

export async function pullSandbox(sandboxId: string): Promise<PullSandboxResult> {
  return await rpc<PullSandboxResult>("sandbox_pull", { sandboxId });
}

export async function openSandbox(sandboxId: string): Promise<OpenSandboxResult> {
  return await rpc<OpenSandboxResult>("sandbox_open", { sandboxId });
}

export async function querySandbox(
  sandboxId: string,
  sql: string,
): Promise<QueryResult> {
  return await rpc<QueryResult>("sandbox_query", { sandboxId, sql });
}

export async function closeSandbox(sandboxId: string): Promise<CloseSandboxResult> {
  return await rpc<CloseSandboxResult>("sandbox_close", { sandboxId });
}

export interface DeleteSandboxResult {
  remote: "deleted" | "not_owner" | "not_found";
  cache: "deleted" | "missing";
}

/** Soft-delete a sandbox. Owners flip its server status to `deleted`
 *  (the row stays for grace + audit, GC handles R2/envelope cleanup) and
 *  the local cache directory is removed. Members get `remote: "not_owner"`
 *  and only their cache is cleaned — the entry then disappears from the
 *  next listing because GET /sandboxes filters status='deleted'. */
export async function deleteSandbox(sandboxId: string): Promise<DeleteSandboxResult> {
  return await rpc<DeleteSandboxResult>("sandbox_delete", { sandboxId });
}

export async function leaveSandbox(sandboxId: string): Promise<{ ok: true }> {
  return await rpc<{ ok: true }>("sandbox_leave", { sandboxId });
}

export interface RepublishSandboxResult {
  ok: true;
  new_blob_sha256: string;
  bytes: number;
}

/** Plan 7: owner-only — re-runs the build pipeline against the source DB,
 *  uploads the fresh `.vsk` to R2 (overwrites the existing blob), bumps
 *  `published_version_count`, and resets `expires_at` to NOW + ttl_days.
 *  Recipients keep access (envelopes preserved); they detect the new
 *  version via `blob_sha256` mismatch on next focus refresh. */
export async function republishSandbox(sandboxId: string): Promise<RepublishSandboxResult> {
  return await rpc<RepublishSandboxResult>("sandbox_republish", { sandboxId });
}

export async function markSandboxesSeen(ids: string[]): Promise<{ ok: true }> {
  return await rpc<{ ok: true }>("sandbox_mark_seen", { ids });
}

export async function listLastSeen(): Promise<{ ids: string[] }> {
  return await rpc<{ ids: string[] }>("sandbox_list_last_seen");
}

export async function listSandboxes(): Promise<{
  cached: SandboxSummary[];
  remote: SandboxSummary[];
  lastSeenIds: string[];
}> {
  const cachedResp = await rpc<{
    sandboxes: Array<{
      sandbox_id: string;
      name: string;
      owner_user_id: string;
      blob_size_bytes: number;
      pulled_at?: string;
      expires_at: string;
      role: "owner" | "member";
    }>;
  }>("sandbox_list_cached");

  const cachedRows = Array.isArray(cachedResp?.sandboxes) ? cachedResp.sandboxes : [];
  const cached: SandboxSummary[] = cachedRows.map((s) => ({
    sandbox_id: s.sandbox_id,
    name: s.name,
    owner_user_id: s.owner_user_id,
    blob_size_bytes: s.blob_size_bytes,
    pulled_at: s.pulled_at,
    expires_at: s.expires_at,
    status: "ready" as const,
    cached: true,
    role: s.role,
  }));

  let remoteResp: {
    sandboxes: Array<{
      id: string;
      name: string;
      status: "ready" | "expired" | "deleted";
      role: "owner" | "member";
      owner_user_id: string;
      expires_at: string;
      created_at: string;
      finalized_at: string | null;
      blob_size_bytes: number | null;
    }>;
    lastSeenIds: string[];
  };
  try {
    remoteResp = await rpc("sandbox_list");
  } catch {
    remoteResp = { sandboxes: [], lastSeenIds: [] };
  }

  const remoteRows = Array.isArray(remoteResp?.sandboxes) ? remoteResp.sandboxes : [];
  const cachedIds = new Set(cached.map((c) => c.sandbox_id));
  const remote: SandboxSummary[] = remoteRows
    .filter((s) => !cachedIds.has(s.id))
    .map((s) => ({
      sandbox_id: s.id,
      name: s.name,
      owner_user_id: s.owner_user_id,
      blob_size_bytes: s.blob_size_bytes ?? 0,
      expires_at: s.expires_at,
      status: s.status,
      cached: false,
      role: s.role,
    }));

  return {
    cached,
    remote,
    lastSeenIds: Array.isArray(remoteResp?.lastSeenIds) ? remoteResp.lastSeenIds : [],
  };
}

// ─── Plan 5b — Owner publish wizard wrappers ───────────────────────────────

/** List every table in a schema with row count + segment size estimate.
 *  Used by Step 2 of the publish wizard ("Available" pane). The Tauri command
 *  resolves Oracle credentials from the keychain server-side and injects them
 *  into the sidecar payload — the renderer never sees the password. */
export async function listSchemaTables(
  connectionId: string,
  schemaName: string,
): Promise<{ tables: SchemaTableInfo[] }> {
  return await rpc<{ tables: SchemaTableInfo[] }>("sandbox_list_schema_tables", {
    connectionId,
    schemaName,
  });
}

/** Compute the BFS FK closure starting from `primaryTables`, walking up to
 *  `fkDepth` hops. Used by Step 2 for the live preview that re-fires on every
 *  checkbox toggle / depth slider change. Credentials resolved server-side. */
export async function computeFkClosure(
  connectionId: string,
  schemaName: string,
  primaryTables: string[],
  fkDepth: number,
): Promise<FkClosureResult> {
  return await rpc<FkClosureResult>("sandbox_compute_fk_closure", {
    connectionId,
    schemaName,
    primaryTables,
    fkDepth,
  });
}

export interface DiscoverPlsqlObject {
  kind: "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE" | "VIEW";
  owner: string;
  name: string;
  refPath: string[];
}

export interface DiscoverPlsqlResult {
  objects: DiscoverPlsqlObject[];
  totalEstimatedDdlBytes: number;
}

/** Discover PL/SQL objects reachable from the given primary tables via Oracle
 *  ALL_DEPENDENCIES. Used by Step 5 of the publish wizard to present an
 *  exclusion checklist before the build runs. Credentials resolved
 *  server-side from the wizard's connectionId. */
export async function discoverPlsql(
  connectionId: string,
  schemaName: string,
  primaryTables: string[],
): Promise<DiscoverPlsqlResult> {
  return await rpc<DiscoverPlsqlResult>("sandbox_discover_plsql", {
    connectionId,
    schemaName,
    primaryTables,
  });
}

/** Run a sandbox build in dry-run mode — introspect + FK walk + PII scan,
 *  then stop. No extraction, no encrypt, no .vsk write. Used by Step 4
 *  (Review) to populate the PII review table without doing the heavy work
 *  twice. The dry-run-done event is delivered in the response's `events`
 *  array; the wizard store consumes it after the call resolves. Credentials
 *  resolved server-side from spec.connectionId. */
export async function buildSandboxDryRun(
  spec: PublishSandboxBuildSpec,
): Promise<SandboxBuildResponse> {
  return await rpc<SandboxBuildResponse>("sandbox_build_dry_run", {
    spec: { ...spec, dryRun: true },
    connectionId: spec.connectionId,
  });
}

/** Run the real (non-dryRun) sandbox build pipeline. Extracts every selected
 *  table from the source, applies PII masks, encrypts, packs the .vsk and
 *  writes it under the app data dir (Rust controls the path — the renderer
 *  cannot suggest one to prevent path-traversal). Returns the
 *  SandboxBuildResponse — result.outPath is the resolved local file the
 *  orchestrator hands to publishSandbox. Credentials resolved server-side
 *  from spec.connectionId. */
export async function buildSandbox(
  spec: PublishSandboxBuildSpec,
): Promise<SandboxBuildResponse> {
  return await rpc<SandboxBuildResponse>("sandbox_build", {
    spec: { ...spec, dryRun: false },
    connectionId: spec.connectionId,
  });
}

export interface PublishSandboxResult {
  sandbox_id: string;
  upload_url?: string;
}

export interface PublishSandboxArgs {
  outPath: string;
  sandboxName: string;
  ttlDays: number;
  memberUserIds: string[];
  specJson: unknown;
  description?: string;
  idempotencyKey?: string;
}

/** Forward a built .vsk to the cloud — sidecar reads the encrypted blob and
 *  recovers the contentKey from disk, seals it for each recipient, uploads
 *  to R2, and registers the manifest. The renderer never carries the key
 *  or the bytes — it only forwards the Rust-controlled outPath returned by
 *  sandbox.build, plus the wizard-collected metadata. */
export async function publishSandbox(
  args: PublishSandboxArgs,
): Promise<PublishSandboxResult> {
  return await rpc<PublishSandboxResult>("sandbox_publish", args);
}

/** Grant a member access to an already-published sandbox — re-encrypts the
 *  contentKey for the recipient's pubkey and registers the membership. */
export async function grantSandbox(
  sandboxId: string,
  newMemberUserId: string,
): Promise<{ ok: boolean }> {
  return await rpc<{ ok: boolean }>("sandbox_grant", {
    sandboxId,
    newMemberUserId,
  });
}

/** Resolve a recipient email to { userId, x25519Pubkey, registeredAt }. The
 *  endpoint returns 404 both when the email isn't a Veesker user AND when the
 *  user has no registered keypair — the two cases are intentionally
 *  indistinguishable to avoid leaking which emails are registered. Returns
 *  null on 404, parsed body on 200, throws on any other status. */
export async function lookupUserByEmail(email: string): Promise<UserLookupResult | null> {
  const token = await getAuthToken();
  const url = `${API_BASE_URL}/v1/users/lookup?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token ?? ""}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`users-lookup failed: ${res.status}`);
  const body = (await res.json()) as {
    user_id: string;
    x25519_pubkey: string;
    registered_at: string;
  };
  return {
    userId: body.user_id,
    x25519Pubkey: body.x25519_pubkey,
    registeredAt: body.registered_at,
  };
}
