// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// Custom JSON-RPC error codes for veesker workspace flow.
// Picked to avoid the JSON-RPC 2.0 reserved range (-32768 .. -32000)
// and our existing transport codes (-32000, -32001, -32002, -32003, -32700, -32601).
export const NO_ACTIVE_SESSION = -32010;
export const SESSION_LOST      = -32011;
export const OBJECT_NOT_FOUND  = -32012;
export const ORACLE_ERR        = -32013;
export const SPLITTER_ERROR    = -32014;
// Connection refused the statement because of a per-connection safety guard.
export const READ_ONLY_BLOCKED  = -32030;
export const UNSAFE_DML_WARNING = -32031;
// L2.1 PSDPM (PL/SQL Developer Parity Mode) — request was blocked because the
// connection only accepts user-initiated SQL.
export const PSDPM_BLOCKED      = -32032;

// Internal safety violation: a connection arrived at execute time with autoCommit=true.
// This should never happen given oracledb.autoCommit is pinned to false at module load —
// the assertion exists so a refactor or future driver default cannot silently re-enable it.
export const AUTOCOMMIT_VIOLATION = -32077;

// Domain code for user-initiated query cancellation.
// Intentionally outside the JSON-RPC reserved range.
export const QUERY_CANCELLED = -2;

// L3.1 — V$SESSION self-viewer (Sprint C Onda 2)
export const SESSION_SELF_PRIV_MISSING = -32033;
export const SESSION_SELF_TRANSIENT = -32034;
export const SESSION_SELF_NOT_FOUND = -32035;

// L3.6 — Sprint C Onda 3 AI per-statement approval gate. Returned when the
// host UI calls ai.approval.resolve with a requestId that is unknown
// (already resolved, never registered, or already timed out).
export const APPROVAL_UNKNOWN_REQUEST_ID = -32036;

// Security item #1: workspace.open refused because the connection has no env
// tag. All connections must declare dev / staging / prod / local before
// any Oracle session is allowed to open.
export const ENV_REQUIRED = -32037;

// Security item #2: env-calibrated unsafe-DML guards.
// -32038: staging double-confirm required — frontend must re-submit with acknowledgeTable.
// -32039: prod blocked — caller must call workspace.unlockUnsafeDml first.
// -32040: TRUNCATE on prod — no bypass available.
export const UNSAFE_DML_STAGING    = -32038;
export const UNSAFE_DML_PROD_BLOCKED = -32039;
export const TRUNCATE_PROD_BLOCKED   = -32040;

// Item #1A T1A.8: mview.refresh on prod requires explicit server-side confirmation.
// Mirrors the unlockUnsafeDml pattern (security item #2) for MV refresh operations.
// -32041 and -32042 are reserved for DDL/DCL modal (Item #1E, not yet implemented).
export const MVIEW_REFRESH_PROD_REQUIRES_CONFIRMATION = -32043;

export class RpcCodedError extends Error {
  code: number;
  data?: Record<string, unknown>;
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "RpcCodedError";
  }
}
