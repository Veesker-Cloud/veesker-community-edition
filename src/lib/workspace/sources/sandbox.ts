// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import {
  openSandbox,
  closeSandbox,
  querySandbox,
  type SandboxSummary,
  type OpenSandboxResult,
  type QueryResult,
} from "$lib/sandbox";
import type { ObjectKind, TableDetails } from "$lib/workspace";
import type { SchemaNode } from "$lib/workspace/SchemaTree.svelte";
import type {
  WorkspaceSource,
  SourceMeta,
  SourceCapabilities,
  OpenResult,
  DdlResult,
  DataflowResult,
} from "./types";

const SANDBOX_KINDS_V1: ReadonlySet<ObjectKind> = new Set<ObjectKind>(["TABLE"]);
const SANDBOX_KINDS_V2: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE",
]);

export const SANDBOX_CAPABILITIES_V1: SourceCapabilities = {
  kinds: SANDBOX_KINDS_V1,
  describeTables: true,
  runQueries: true,
  tabs: ["schema"],
};

export const SANDBOX_CAPABILITIES_V2: SourceCapabilities = {
  kinds: SANDBOX_KINDS_V2,
  describeTables: true,
  runQueries: true,
  tabs: ["schema"],
};

export function formatExpiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expires in ${days}d`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `expires in ${hours}h`;
}

export class SandboxWorkspaceSource implements WorkspaceSource {
  meta: SourceMeta;
  capabilities: SourceCapabilities = SANDBOX_CAPABILITIES_V1;
  private opened: OpenSandboxResult | null = null;
  private hasPlsql = false;
  private skippedObjectsWarnings: string[] = [];

  constructor(sb: SandboxSummary) {
    this.meta = {
      id: sb.sandbox_id,
      kind: "sandbox",
      displayName: sb.name,
      subtitle: formatExpiresIn(sb.expires_at),
      role: sb.role,
      expiresAt: sb.expires_at,
    };
  }

  async open(): Promise<OpenResult> {
    try {
      this.opened = await openSandbox(this.meta.id);
      this.hasPlsql = await this.checkVskTableExists("__vsk_objects");
      this.capabilities = this.hasPlsql ? SANDBOX_CAPABILITIES_V2 : SANDBOX_CAPABILITIES_V1;
      if (this.hasPlsql && this.opened?.skippedObjects) {
        this.skippedObjectsWarnings = this.opened.skippedObjects.map(
          (s) => `${s.reason}: ${s.kind} ${s.owner}.${s.name}`,
        );
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getWarnings(): string[] {
    return this.skippedObjectsWarnings;
  }

  private async checkVskTableExists(tableName: string): Promise<boolean> {
    try {
      const r = await querySandbox(
        this.meta.id,
        `SELECT 1 FROM information_schema.tables WHERE table_name = '${tableName}'`,
      );
      return r.rows.length > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Sandbox close failures are non-fatal: DuckDB has no server-side session
    // to leak. (Oracle source close() doesn't catch because a leaked session
    // there pins real resources.)
    try {
      await closeSandbox(this.meta.id);
    } catch {
      /* swallow */
    }
    this.opened = null;
  }

  async listSchemas(): Promise<SchemaNode[]> {
    const tables = this.opened?.tables ?? [];
    return [
      {
        name: this.meta.displayName,
        isCurrent: true,
        expanded: true,
        kinds: {
          TABLE: { kind: "ok", value: tables.map((t) => ({ name: t })) },
        },
      },
    ];
  }

  async listObjects(_schema: string, kind: ObjectKind): Promise<{ name: string }[]> {
    if (this.hasPlsql) {
      try {
        const r = await querySandbox(
          this.meta.id,
          `SELECT name FROM __vsk_objects WHERE kind = '${kind.replace(/'/g, "''")}' ORDER BY name`,
        );
        return r.rows.map((row: unknown[]) => ({ name: row[0] as string }));
      } catch {
        // V2 query failure → return empty rather than crashing the SchemaTree.
        return [];
      }
    }
    if (kind !== "TABLE") return [];
    return (this.opened?.tables ?? []).map((t) => ({ name: t }));
  }

  // TODO(plan12): isPk is hardcoded to false because OpenSandboxResult.columns
  // doesn't expose PK info. DuckDB's PRAGMA table_info() reveals it; surfacing
  // requires extending the sandbox.open RPC to return per-column is_pk.
  // Until that lands, sandbox tables will render without PK badges in
  // ObjectDetails.svelte. Address before/during Task 7 if it blocks UX.
  async describeTable(_schema: string, table: string): Promise<TableDetails> {
    const cols = (this.opened?.columns ?? []).filter((c) => c.table_name === table);
    return {
      columns: cols.map((c) => ({
        name: c.name,
        dataType: c.type,
        nullable: c.nullable,
        isPk: false,
        dataDefault: null,
        comments: null,
      })),
      indexes: [],
      rowCount: null,
      lastAnalyzed: null,
    };
  }

  async runQuery(sql: string): Promise<QueryResult> {
    return await querySandbox(this.meta.id, sql);
  }

  async loadDdl(schema: string, name: string, kind: ObjectKind): Promise<DdlResult> {
    if (!this.hasPlsql) return { kind: "unsupported" };
    try {
      const r = await querySandbox(
        this.meta.id,
        `SELECT ddl, spec, body FROM __vsk_source WHERE kind = '${kind.replace(/'/g, "''")}' AND owner = '${schema.replace(/'/g, "''")}' AND name = '${name.replace(/'/g, "''")}'`,
      );
      if (r.rows.length === 0) {
        return { kind: "error", error: "DDL not found in sandbox" };
      }
      const row = r.rows[0] as [string, string | null, string | null];
      return {
        kind: "ok",
        ddl: row[0],
        spec: row[1] ?? undefined,
        body: row[2] ?? undefined,
      };
    } catch (e) {
      return { kind: "error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async loadDataflow(): Promise<DataflowResult> {
    return { kind: "unsupported" };
  }
}
