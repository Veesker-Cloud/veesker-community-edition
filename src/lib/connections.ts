// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { invoke } from "@tauri-apps/api/core";

export type ConnectionEnv = "dev" | "staging" | "prod" | "local";

export type ConnectionSafety = {
  /** "dev" | "staging" | "prod" — undefined = unspecified */
  env?: ConnectionEnv;
  /** when true, sidecar refuses DML/DDL on this connection */
  readOnly: boolean;
  /** per-statement timeout (ms); undefined / 0 = unlimited */
  statementTimeoutMs?: number;
  /** when true, warn before UPDATE/DELETE without WHERE */
  warnUnsafeDml: boolean;
  /** when true, frontend runs background EXPLAIN PLAN + stats analysis */
  autoPerfAnalysis: boolean;
  /**
   * L1.2 (Sprint C): when true, every Tauri command that makes outbound HTTPS
   * calls (cloud sync, AI, GitHub object versioning, sandbox sync) returns
   * -32099 while this connection is active. Default-on for prod connections
   * at save time.
   */
  airgapMode: boolean;
  /**
   * L2.1 PSDPM (PL/SQL Developer Parity Mode). When true, AI tools, embed
   * batches and any non-user-initiated SQL are blocked. Schema browser
   * remains purely lazy. Defaults true for env=prod / env=staging at save.
   */
  psdpmMode?: boolean;
  /**
   * L3.2 (Onda 3) per-connection auto-EXPLAIN mode.
   * "manual" — only when the user runs EXPLAIN PLAN explicitly (F9).
   * "when_dml" — auto-EXPLAIN before every DML/SELECT (recommended for prod/staging).
   * "always" — auto-EXPLAIN before every statement.
   * Default at save time: dev / unspecified → "manual"; staging / prod → "when_dml".
   */
  autoExplainMode: "manual" | "always" | "when_dml";
};

/**
 * Save-time variant of {@link ConnectionSafety}. When `airgapMode`,
 * `psdpmMode` or `autoExplainMode` is left undefined the Rust persistence
 * layer derives the defaults from the connection env.
 */
export type ConnectionSafetyInput = Omit<
  ConnectionSafety,
  "airgapMode" | "psdpmMode" | "autoExplainMode"
> & {
  airgapMode?: boolean;
  psdpmMode?: boolean;
  autoExplainMode?: "manual" | "always" | "when_dml";
};

export const DEFAULT_SAFETY: ConnectionSafety = {
  env: undefined,
  readOnly: false,
  statementTimeoutMs: undefined,
  warnUnsafeDml: false,
  autoPerfAnalysis: true,
  airgapMode: false,
  psdpmMode: false,
  autoExplainMode: "manual",
};

type SafetyFields = ConnectionSafety;

export type ConnectionMeta =
  | ({
      authType: "basic";
      id: string;
      name: string;
      host: string;
      port: number;
      serviceName: string;
      username: string;
      createdAt: string;
      updatedAt: string;
    } & SafetyFields)
  | ({
      authType: "wallet";
      id: string;
      name: string;
      connectAlias: string;
      username: string;
      createdAt: string;
      updatedAt: string;
    } & SafetyFields);

export type ConnectionFull = {
  meta: ConnectionMeta;
  passwordSet: boolean;
  walletPasswordSet?: boolean;
};

export type ConnectionInput =
  | {
      authType: "basic";
      id?: string;
      name: string;
      host: string;
      port: number;
      serviceName: string;
      username: string;
      password: string;
      safety?: ConnectionSafetyInput;
    }
  | {
      authType: "wallet";
      id?: string;
      name: string;
      walletZipPath?: string;
      walletPassword: string;
      connectAlias: string;
      username: string;
      password: string;
      safety?: ConnectionSafetyInput;
    };

export type WalletInfo = { aliases: string[] };

export type ConnectionError = { code: number; message: string };

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: ConnectionError };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<Result<T>> {
  try {
    const data = await invoke<T>(cmd, args);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err as ConnectionError };
  }
}

export const listConnections = () => call<ConnectionMeta[]>("connection_list");
export const getConnection = (id: string) => call<ConnectionFull>("connection_get", { id });
export const saveConnection = (input: ConnectionInput) =>
  call<ConnectionMeta>("connection_save", { input });
export const deleteConnection = (id: string) => call<void>("connection_delete", { id });
export const walletInspect = (zipPath: string) =>
  call<WalletInfo>("wallet_inspect", { zipPath });

/**
 * L2.1: read the active PSDPM flag from the Tauri-side per-session state.
 * Returns false when no workspace is open or the connection has PSDPM off.
 */
export const psdpmActive = () => call<boolean>("psdpm_active");

/** Pre-flight check that an Oracle connection has resolvable sandbox credentials
 *  (basic-auth + keychain entry present). Returns Ok(undefined) on success or a
 *  descriptive error. The actual password never leaves the Rust process — every
 *  sandbox.* Tauri command resolves it server-side and forwards to the sidecar
 *  over the trusted stdin pipe. */
export const sandboxOracleCheck = (id: string) =>
  call<void>("connection_sandbox_oracle_check", { id });
