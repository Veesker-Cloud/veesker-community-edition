// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { buildSandbox, makeProductionBuildEnv } from "./sandbox/build";
import { computeFkClosure } from "./sandbox/compute-fk-closure";
import { fkSingleHop } from "./sandbox/fk-walk";
import { listSchemaTables } from "./sandbox/list-schema-tables";
import { openOracleConnection } from "./sandbox/oracle-source";
import { expandSandboxEnvelope } from "./sandbox-cloud/handlers";
import type {
  SandboxBuildSpec,
  BuildProgressEvent,
  SandboxBuildResult,
  SchemaTableInfo,
  FkClosureResult,
} from "./sandbox/types";

export interface SandboxBuildParams {
  spec: SandboxBuildSpec;
  oracleConfig: {
    user: string;
    password: string;
    connectString: string;
  };
  /** Owner account from the rpc envelope. Merged into spec.ownerAccount when the
   *  spec doesn't already set it (the Plan 5b wizard wrappers don't, since
   *  ownerAccount is an envelope-level identity field, not a build parameter).
   *  Renderer-supplied values are scrubbed by the Rust shell — the trustworthy
   *  ownerAccount is the one expandSandboxEnvelope derives from apiToken. */
  ownerAccount?: string;
  /** JWT injected by the Rust shell (commands.rs::inject_cloud_envelope). The
   *  sidecar decodes it via expandSandboxEnvelope to derive identity. */
  apiToken?: string;
  apiBaseUrl?: string;
}

export interface SandboxBuildResponse {
  result: SandboxBuildResult;
  events: BuildProgressEvent[];
}

/**
 * JSON-RPC handler for `sandbox.build`. The desktop sends the resolved
 * Oracle credentials + a SandboxBuildSpec, and receives the final
 * SandboxBuildResult plus the full progress event log.
 *
 * v1 batches all events into the response (the existing sidecar JSON-RPC
 * surface has no notification stream). Plan 5's wizard UI may switch to a
 * streaming variant if real-time progress display becomes a UX
 * requirement; until then, the wizard renders the event log post-hoc.
 */
export async function handleSandboxBuild(
  rawParams: SandboxBuildParams,
): Promise<SandboxBuildResponse> {
  const params = await expandSandboxEnvelope({
    ...rawParams,
    apiToken: rawParams.apiToken ?? "",
  });
  const env = makeProductionBuildEnv(params.oracleConfig);
  const events: BuildProgressEvent[] = [];
  const specWithOwner: SandboxBuildSpec = {
    ...params.spec,
    ownerAccount: params.spec.ownerAccount ?? params.ownerAccount ?? "",
  };
  const result = await buildSandbox(specWithOwner, env, (e) => {
    events.push(e);
  });
  return { result, events };
}

export interface SandboxListSchemaTablesParams {
  /** Oracle credentials, resolved by the desktop before the call. The sidecar
   *  has no connection registry — we open a one-shot connection per RPC,
   *  matching the pattern established by sandbox.build. */
  oracleConfig: {
    user: string;
    password: string;
    connectString: string;
  };
  /** Schema/owner to enumerate. Uppercased before binding. */
  schemaName: string;
}

export interface SandboxListSchemaTablesResponse {
  tables: SchemaTableInfo[];
}

/**
 * JSON-RPC handler for `sandbox.list-schema-tables`. Returns every table the
 * given owner has, with stale-permitted row count and segment size estimate.
 * Used by the Plan 5b owner publish wizard's Step 2 "Available" pane.
 */
export async function handleSandboxListSchemaTables(
  params: SandboxListSchemaTablesParams,
): Promise<SandboxListSchemaTablesResponse> {
  const conn = await openOracleConnection(params.oracleConfig);
  try {
    const tables = await listSchemaTables(conn, params.schemaName.toUpperCase());
    return { tables };
  } finally {
    await conn.close();
  }
}

export interface SandboxComputeFkClosureParams {
  /** Oracle credentials, resolved by the desktop before the call. Same
   *  one-shot connection-per-RPC pattern as sandbox.list-schema-tables. */
  oracleConfig: {
    user: string;
    password: string;
    connectString: string;
  };
  /** Schema/owner the BFS walk runs in. Uppercased before binding. */
  schemaName: string;
  /** Tables explicitly chosen by the owner; uppercased before binding. */
  primaryTables: string[];
  /** FK walk depth requested by the wizard; clamped to [1, 5]. */
  fkDepth: number;
}

/**
 * JSON-RPC handler for `sandbox.compute-fk-closure`. Returns the BFS
 * closure (entries with depth + the FK edge that pulled each table)
 * plus the raw edge set. Used by the Plan 5b owner publish wizard's
 * Step 2 picker for the live preview that updates as the owner picks
 * tables or moves the FK depth slider.
 */
export async function handleSandboxComputeFkClosure(
  params: SandboxComputeFkClosureParams,
): Promise<FkClosureResult> {
  // Avoid the connection round-trip when the wizard has nothing selected.
  // The Step 2 picker re-fires this RPC on every checkbox toggle.
  if (params.primaryTables.length === 0) {
    return { entries: [], edges: [] };
  }
  const conn = await openOracleConnection(params.oracleConfig);
  try {
    return await computeFkClosure({
      owner: params.schemaName.toUpperCase(),
      primaryTables: params.primaryTables.map((t) => t.toUpperCase()),
      maxDepth: Math.max(1, Math.min(5, params.fkDepth | 0)),
      singleHop: (owner, tables) => fkSingleHop(conn, owner, tables),
    });
  } finally {
    await conn.close();
  }
}

import { discoverPlsql } from "./sandbox/discoverPlsql";
import { discoverDependenciesOnce } from "./sandbox/oracle-source";

const PLSQL_AVG_DDL_BYTES = 2048;

export interface DiscoverPlsqlParams {
  oracleConfig: { user: string; password: string; connectString: string };
  schemaName: string;
  primaryTables: string[];
}

export async function handleSandboxDiscoverPlsql(params: DiscoverPlsqlParams): Promise<{
  objects: Array<{ kind: string; owner: string; name: string; refPath: string[] }>;
  totalEstimatedDdlBytes: number;
}> {
  if (!params || typeof params.schemaName !== "string" || !Array.isArray(params.primaryTables)) {
    throw new Error("sandbox.discover_plsql: missing schemaName or primaryTables[]");
  }
  // Open a dedicated connection from the wizard-injected oracleConfig (mirrors
  // handleSandboxComputeFkClosure / handleSandboxListSchemaTables). Using the
  // interactive session would force the wizard to require a workspace open
  // first — the wizard is the FIRST place this connection's credentials are
  // exercised, so it must stand alone.
  const conn = await openOracleConnection(params.oracleConfig);
  try {
    const schema = params.schemaName.toUpperCase();
    const tables = params.primaryTables.map((t) => t.toUpperCase());
    const r = await discoverPlsql(
      (owner, names) => discoverDependenciesOnce(conn, owner, names),
      schema,
      tables,
    );
    return {
      objects: r.objects,
      totalEstimatedDdlBytes: r.objects.length * PLSQL_AVG_DDL_BYTES,
    };
  } finally {
    await conn.close();
  }
}
