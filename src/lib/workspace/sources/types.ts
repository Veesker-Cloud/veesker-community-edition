// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { ObjectKind, TableDetails, DataFlowResult, WorkspaceInfo } from "$lib/workspace";
import type { SchemaNode } from "$lib/workspace/SchemaTree.svelte";
import type { QueryResult } from "$lib/sandbox";

export type SourceKind = "oracle" | "sandbox";

// Carries the underlying RPC error code (e.g. SESSION_LOST = -32011) so the
// component can branch on `err.code` without losing the original signal.
export class SourceError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

export interface SourceCapabilities {
  kinds: ReadonlySet<ObjectKind>;
  describeTables: boolean;
  runQueries: boolean;
  tabs: ReadonlyArray<"schema" | "dashboard">;
}

export interface SourceMeta {
  id: string;
  kind: SourceKind;
  displayName: string;
  subtitle: string;
  role?: "owner" | "member";
  expiresAt?: string;
}

// `spec` and `body` are Oracle-only PACKAGE extras (DBMS_METADATA returns them
// separately for PACKAGE — the component opens `body` in the editor and stashes
// `spec` on the same tab via sqlEditor.setPackageSpec). Sandbox sources omit them.
export type DdlResult =
  | { kind: "ok"; ddl: string; spec?: string; body?: string }
  | { kind: "unsupported" }
  | { kind: "error"; error: string; code?: number };

export type DataflowResult =
  | { kind: "ok"; data: DataFlowResult }
  | { kind: "unsupported" }
  | { kind: "error"; error: string; code?: number };

// info is Oracle-only — sandbox doesn't surface workspace stats. The
// component currently gates render on info presence (Task 8 will replace
// that gate with source-meta-driven rendering).
export type OpenResult =
  | { ok: true; info?: WorkspaceInfo }
  | { ok: false; error: string };

export interface WorkspaceSource {
  meta: SourceMeta;
  capabilities: SourceCapabilities;
  open(): Promise<OpenResult>;
  close(): Promise<void>;
  listSchemas(): Promise<SchemaNode[]>;
  listObjects(schema: string, kind: ObjectKind): Promise<{ name: string }[]>;
  describeTable(schema: string, table: string): Promise<TableDetails>;
  runQuery(sql: string): Promise<QueryResult>;
  loadDdl(schema: string, name: string, kind: ObjectKind): Promise<DdlResult>;
  loadDataflow(schema: string, name: string, kind: ObjectKind): Promise<DataflowResult>;
}
