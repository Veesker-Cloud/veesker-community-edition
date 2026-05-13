// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import {
  workspaceOpen,
  workspaceClose,
  schemaList,
  objectsList,
  objectsListPlsql,
  tableDescribe,
  objectDdlGet,
  objectDataflowGet,
  type ObjectKind,
  type TableDetails,
} from "$lib/workspace";
import type { SchemaNode } from "$lib/workspace/SchemaTree.svelte";
import type { ConnectionMeta } from "$lib/connections";
import type { QueryResult } from "$lib/sandbox";
import {
  SourceError,
  type WorkspaceSource,
  type SourceMeta,
  type SourceCapabilities,
  type OpenResult,
  type DdlResult,
  type DataflowResult,
} from "./types";

const ORACLE_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "TABLE",
  "VIEW",
  "SEQUENCE",
  "PROCEDURE",
  "FUNCTION",
  "PACKAGE",
  "TRIGGER",
  "TYPE",
  "REST_MODULE",
]);

const PLSQL_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "PROCEDURE",
  "FUNCTION",
  "PACKAGE",
  "TRIGGER",
  "TYPE",
]);

export const ORACLE_CAPABILITIES: SourceCapabilities = {
  kinds: ORACLE_KINDS,
  describeTables: true,
  runQueries: true,
  tabs: ["schema", "dashboard"],
};

function subtitleFromConn(c: ConnectionMeta): string {
  if (c.authType === "basic") {
    return `${c.username} @ ${c.host}:${c.port}/${c.serviceName}`;
  }
  return `${c.username} @ ${c.connectAlias}`;
}

// duplicated from +page.svelte:175-191; consolidates when Task 6 rewrites that section to use source.listSchemas()
function newSchemaNode(name: string, isCurrent: boolean): SchemaNode {
  return {
    name,
    isCurrent,
    expanded: isCurrent,
    kinds: {
      TABLE: { kind: "idle" },
      VIEW: { kind: "idle" },
      SEQUENCE: { kind: "idle" },
      PROCEDURE: { kind: "idle" },
      FUNCTION: { kind: "idle" },
      PACKAGE: { kind: "idle" },
      TRIGGER: { kind: "idle" },
      TYPE: { kind: "idle" },
      REST_MODULE: { kind: "idle" },
    },
  };
}

export class OracleWorkspaceSource implements WorkspaceSource {
  meta: SourceMeta;
  capabilities = ORACLE_CAPABILITIES;

  constructor(private conn: ConnectionMeta) {
    this.meta = {
      id: conn.id,
      kind: "oracle",
      displayName: conn.name,
      subtitle: subtitleFromConn(conn),
    };
  }

  async open(): Promise<OpenResult> {
    const r = await workspaceOpen(this.conn.id);
    return r.ok ? { ok: true, info: r.data } : { ok: false, error: r.error.message };
  }

  async close(): Promise<void> {
    await workspaceClose();
  }

  async listSchemas(): Promise<SchemaNode[]> {
    const r = await schemaList();
    if (!r.ok) throw new SourceError(r.error.message, r.error.code);
    return r.data.map((s) => newSchemaNode(s.name, s.isCurrent));
  }

  async listObjects(schema: string, kind: ObjectKind): Promise<{ name: string }[]> {
    if (PLSQL_KINDS.has(kind)) {
      const r = await objectsListPlsql(schema, kind);
      if (!r.ok) throw new SourceError(r.error.message, r.error.code);
      return r.data;
    }
    const r = await objectsList(schema, kind);
    if (!r.ok) throw new SourceError(r.error.message, r.error.code);
    return r.data;
  }

  async describeTable(schema: string, table: string): Promise<TableDetails> {
    const r = await tableDescribe(schema, table);
    if (!r.ok) throw new SourceError(r.error.message, r.error.code);
    return r.data;
  }

  // Oracle query execution flows through `sqlEditor` (in `$lib/stores/sql-editor.svelte`),
  // which owns history, package metadata, version capture, unsafe-DML acks, and
  // cancellation. Centralising here would have to re-implement all of that, so the
  // component branches on `source.meta.kind` and calls `sqlEditor` directly for Oracle.
  // This shim guards against accidental misuse.
  async runQuery(_sql: string): Promise<QueryResult> {
    throw new Error("OracleWorkspaceSource.runQuery: use sqlEditor for Oracle queries");
  }

  async loadDdl(schema: string, name: string, kind: ObjectKind): Promise<DdlResult> {
    const r = await objectDdlGet(schema, kind, name);
    if (r.ok) return { kind: "ok", ddl: r.data.ddl, spec: r.data.spec, body: r.data.body };
    return { kind: "error", error: r.error.message, code: r.error.code };
  }

  async loadDataflow(schema: string, name: string, kind: ObjectKind): Promise<DataflowResult> {
    const r = await objectDataflowGet(schema, kind, name);
    if (r.ok) return { kind: "ok", data: r.data };
    return { kind: "error", error: r.error.message, code: r.error.code };
  }
}
