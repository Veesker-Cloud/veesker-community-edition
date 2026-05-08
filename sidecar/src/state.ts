// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { randomUUID } from "node:crypto";
import type oracledb from "oracledb";
import type { ConnectionSafety, OpenSessionParams } from "./oracle";
import { RpcCodedError, NO_ACTIVE_SESSION } from "./errors";

// Process-lifetime stable identifier surfaced to Oracle via DBMS_SESSION.SET_IDENTIFIER.
// Each sidecar process gets exactly one — used to correlate V$SESSION rows back to a
// specific Veesker run for forensic / audit purposes.
export const SESSION_UUID: string = randomUUID();

let currentSession: oracledb.Connection | null = null;
let currentSchema: string | null = null;

export function setSession(conn: oracledb.Connection, schema: string): void {
  currentSession = conn;
  currentSchema = schema;
}

export function clearSession(): void {
  currentSession = null;
  currentSchema = null;
  _sessionSafety = {};
  _sessionParams = null;
  resetTxState();
}

// ── Authoritative transaction state (Item #4) ───────────────────────────────
// Tracks pending uncommitted work for the active Oracle session. The sidecar
// owns exactly one connection at a time, so this is a single global record —
// not a per-connection map. The frontend correlates the active connectionId
// at the tab level. State resets on workspace.open, workspace.close,
// connection.commit, connection.rollback, and any session loss path.
//
// The counter is best-effort and intentionally simple: it increments for every
// successful dml/ddl/plsql statement, but the AUTHORITATIVE truth is the txId
// returned by `DBMS_TRANSACTION.LOCAL_TRANSACTION_ID`. If Oracle reports null,
// `resetTxState()` is called and the counter goes back to 0 — so DDL implicit
// commits, anonymous PL/SQL blocks containing COMMIT, lost sessions, etc. all
// converge on the correct state at the next consult.
export type TxModifyingType = "dml" | "ddl" | "plsql";

export interface TxState {
  pendingStatements: number;
  lastTxId: string | null;
  lastModifyingAt: number | null;
  lastModifyingType: TxModifyingType | null;
}

let _txState: TxState = {
  pendingStatements: 0,
  lastTxId: null,
  lastModifyingAt: null,
  lastModifyingType: null,
};

export function getTxState(): TxState {
  return { ..._txState };
}

export function resetTxState(): void {
  _txState = {
    pendingStatements: 0,
    lastTxId: null,
    lastModifyingAt: null,
    lastModifyingType: null,
  };
}

export function recordTxModifying(
  type: TxModifyingType,
  txId: string | null,
  at: number = Date.now(),
): void {
  _txState.pendingStatements += 1;
  _txState.lastModifyingType = type;
  _txState.lastModifyingAt = at;
  _txState.lastTxId = txId;
}

export function setTxId(txId: string | null): void {
  _txState.lastTxId = txId;
}

export function getActiveSession(): oracledb.Connection {
  if (currentSession === null) {
    throw new RpcCodedError(
      NO_ACTIVE_SESSION,
      "No active workspace session. Call workspace.open first."
    );
  }
  return currentSession;
}

export function hasSession(): boolean {
  return currentSession !== null;
}

export function getCurrentSchema(): string | null {
  return currentSchema;
}

let _sessionParams: OpenSessionParams | null = null;
let _sessionSafety: ConnectionSafety = {};

export function setSessionParams(p: OpenSessionParams): void {
  _sessionParams = p;
}

export function getSessionParams(): OpenSessionParams | null {
  return _sessionParams;
}

export function setSessionSafety(s: ConnectionSafety): void {
  _sessionSafety = s ?? {};
}

export function getSessionSafety(): ConnectionSafety {
  return _sessionSafety;
}

// Serializes openSession/closeSession across the process so concurrent
// requests cannot race and orphan a connection.
let _sessionMutex: Promise<void> = Promise.resolve();

export async function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = _sessionMutex;
  let release!: () => void;
  _sessionMutex = new Promise<void>((res) => {
    release = res;
  });
  try {
    await prior;
    return await fn();
  } finally {
    release();
  }
}
