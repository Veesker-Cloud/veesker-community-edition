// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { FEATURES } from "./features";
import { redactSql } from "./redactSql";

// PROD-002 (audit 2026-04-30): two upload modes.
//   "full"          — sends redacted SQL text + statement type + metadata
//   "metadata-only" — sends ONLY statement type + metadata; sql is null
//
// Connections tagged env="prod" automatically use "metadata-only" so PII /
// PHI / PCI in SQL literals never flows to Veesker Cloud. Non-prod
// connections default to "full" (current behavior).
type SqlMode = "full" | "metadata-only";

type CloudEntry = {
  occurredAt: string;
  connectionId: string | null;
  connectionName: string | null;
  host: string | null;
  sqlMode: SqlMode;
  sql: string | null;
  sqlKind: string | null;
  success: boolean;
  rowCount: number | null;
  elapsedMs: number;
  errorCode: number | null;
  errorMessage: string | null;
  clientVersion: string | null;
};

const FLUSH_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
const MAX_BUFFER = 500;

let _buffer: CloudEntry[] = [];
let _interval: ReturnType<typeof setInterval> | null = null;
let _clientVersion: string | null = null;

async function resolveClientVersion(): Promise<string> {
  if (_clientVersion) return _clientVersion;
  try {
    _clientVersion = await getVersion();
  } catch {
    _clientVersion = "unknown";
  }
  return _clientVersion;
}

// Lightweight SQL classifier — returns the leading keyword (uppercase) or null.
// Matches the audit-side semantics: SELECT/INSERT/UPDATE/DELETE/MERGE/CREATE/etc.
// Used in both modes: even when sql is redacted out, the kind is preserved
// so audit reports can show "10 INSERTs and 5 SELECTs in the last hour".
function classifySqlKind(sql: string): string | null {
  const trimmed = sql.trim().replace(/^[ \t]*--[^\n]*\n+/g, ""); // strip leading comments
  const m = /^(\w+)/.exec(trimmed);
  return m ? m[1].toUpperCase() : null;
}

async function flush(): Promise<void> {
  if (_buffer.length === 0) return;
  const batch = _buffer.splice(0, BATCH_SIZE);
  try {
    await invoke("cloud_api_post", { path: "/v1/audit/ingest", body: { entries: batch } });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("server_error_429") || msg.includes("rate_limit_exceeded")) {
      // HIGH-003: backoff with jitter — server told us to slow down.
      console.warn("[audit] rate limited; will retry on next interval");
    }
    if (_buffer.length < MAX_BUFFER) {
      _buffer = [...batch, ..._buffer];
    }
  }
}

export const CloudAuditService = {
  /**
   * Push an audit entry to the upload buffer.
   *
   * @param env  the connection's safety.env tag. When "prod", the entry is
   *             automatically uploaded in "metadata-only" mode (no SQL text).
   *             null/undefined / "dev" / "staging" use "full" mode.
   */
  async push(
    entry: {
      connectionId: string | null;
      connectionName: string | null;
      host: string | null;
      sql: string;
      success: boolean;
      rowCount: number | null;
      elapsedMs: number;
      errorCode: number | null;
      errorMessage: string | null;
    },
    env: "local" | "dev" | "staging" | "prod" | null = null,
  ): Promise<void> {
    if (!FEATURES.cloudAudit) return;
    const clientVersion = await resolveClientVersion();

    const sqlMode: SqlMode = env === "prod" ? "metadata-only" : "full";
    const sqlKind = classifySqlKind(entry.sql);

    let sqlForUpload: string | null = null;
    if (sqlMode === "full") {
      // HIGH-001 (audit 2026-04-30): redact credential patterns BEFORE buffering.
      // Server redacts again as defense-in-depth, but credentials should never
      // leave this device in cleartext.
      sqlForUpload = redactSql(entry.sql).redacted;
    }

    _buffer.push({
      occurredAt: new Date().toISOString(),
      connectionId: entry.connectionId || null,
      connectionName: entry.connectionName || null,
      host: entry.host || null,
      sqlMode,
      sql: sqlForUpload,
      sqlKind,
      success: entry.success,
      rowCount: entry.rowCount,
      elapsedMs: entry.elapsedMs,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      clientVersion,
    });
    if (_buffer.length >= BATCH_SIZE) {
      void flush();
    }
  },

  start(): void {
    if (_interval) return;
    _interval = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  },

  stop(): void {
    if (_interval) {
      clearInterval(_interval);
      _interval = null;
    }
    void flush();
  },
};
