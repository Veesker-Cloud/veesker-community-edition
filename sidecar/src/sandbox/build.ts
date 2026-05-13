import oracledb from "oracledb";
import {
  DuckDBHost,
  writeEncryptedVsk,
  sodiumReady,
  generateKeypair,
  publicKeyFromPrivate,
  randomKey,
  sealEnvelope,
  OsKeyringStore,
  mapOracleType,
  type VskManifest,
  type EncryptedVskAadContext,
} from "@veesker/engine";
import type {
  SandboxBuildSpec,
  BuildProgressEvent,
  SandboxBuildResult,
  PiiSuggestion,
} from "./types";
import type { ColumnMeta, OracleConnectionConfig } from "./oracle-source";
import {
  quoteIdent,
  introspectTable,
  extractRows as orchestratorExtractRows,
  sampleColumnValues as orchestratorSampleColumn,
  openOracleConnection,
  discoverDependenciesOnce,
} from "./oracle-source";
import type { FkEdge } from "./fk-walk";
import { walkFkBfs, fkSingleHop } from "./fk-walk";
import { guardColumnTypes, formatTypeGuardError, type TypeGuardReport } from "./type-guard";
import { detectColumnPii } from "./pii/detector";
import { extractObjectDdl } from "./oracle-source";
import type { ObjectRow, SourceRow } from "./extractPlsqlDdl";
import type { DiscoveredDependency } from "./discoverPlsql";

/**
 * Dependency-injected environment. Lets the orchestrator be unit-tested
 * with mocks (test) and run real Oracle/engine work in production.
 */
export interface BuildEnv {
  openConnection: (connectionId: string) => Promise<{ close: () => Promise<void> }>;
  introspect: (
    conn: object,
    owner: string,
    tableName: string,
  ) => Promise<ColumnMeta[]>;
  fkSingleHop: (
    conn: object,
    owner: string,
    tables: string[],
  ) => Promise<FkEdge[]>;
  extractRows: (
    conn: object,
    owner: string,
    tableName: string,
    whereClause: string | undefined,
    rowCap: number | undefined,
  ) => Promise<Record<string, unknown>[]>;
  writeEncryptedVskAt: (
    outPath: string,
    manifest: object,
    rowsByTable: Record<string, Record<string, unknown>[]>,
    contentKey: Uint8Array,
    envelope: { ciphertext: Uint8Array; nonce: Uint8Array },
    plsql?: {
      objectRows: ObjectRow[];
      sourceRows: SourceRow[];
      dependencies: DiscoveredDependency[];
    },
    aadContext?: EncryptedVskAadContext,
  ) => Promise<void>;
  sealEnvelopeForOwner: (ownerAccount: string) => Promise<{
    contentKey: Uint8Array;
    envelope: { ciphertext: Uint8Array; nonce: Uint8Array };
  }>;
  pii: {
    sampleColumn: (
      conn: object,
      owner: string,
      tableName: string,
      columnName: string,
      sampleSize: number,
    ) => Promise<(string | null)[]>;
    detect: (
      columnName: string,
      samples: (string | null)[],
    ) => null | { category: string; signal: string; confidence: number; defaultMask: string };
  };
  discoverDependencies: (
    conn: object,
    schema: string,
    referencedNames: string[],
  ) => Promise<Array<{
    name: string;
    type: string;
    referencedName: string;
    referencedOwner: string;
    referencedType: string;
  }>>;
  extractDdl: (
    conn: object,
    i: { kind: string; owner: string; name: string },
  ) => Promise<{
    ddl: string;
    spec?: string;
    body?: string;
  }>;
}

const TTL_MIN_DAYS = 1;
const TTL_MAX_DAYS = 90;
const PII_SAMPLE_SIZE = 200;
const DEFAULT_FK_DEPTH = 2;
const FK_WALK_DEPTH_MIN = 1;
const FK_WALK_DEPTH_MAX = 5;
const MANIFEST_ENGINE_VERSION = "0.2.0";
const MANIFEST_DATA_FORMAT = "parquet-streams-v1";

/**
 * Run the full build pipeline. Emits progress events via `onProgress`.
 * Returns the final SandboxBuildResult on success; throws on validation
 * or runtime errors.
 */
export async function buildSandbox(
  spec: SandboxBuildSpec,
  env: BuildEnv,
  onProgress: (e: BuildProgressEvent) => void,
): Promise<SandboxBuildResult> {
  validateSpec(spec);
  onProgress({
    phase: "starting",
    spec: { sandboxName: spec.sandboxName, primaryTableCount: spec.primaryTables.length },
  });

  const conn = await env.openConnection(spec.connectionId);
  try {
    onProgress({ phase: "introspecting-schema", tables: spec.primaryTables.map((t) => t.name) });
    const primaryNames = spec.primaryTables.map((t) => t.name);
    const schemas: Record<string, ColumnMeta[]> = {};
    for (const t of primaryNames) {
      schemas[t] = await env.introspect(conn, spec.schemaName, t);
    }

    const fkResult = await walkFkBfs(
      spec.schemaName,
      primaryNames,
      (owner, tables) => env.fkSingleHop(conn, owner, tables),
      spec.fkWalkDepth ?? DEFAULT_FK_DEPTH,
    );
    const fkAdded = fkResult.tablesIncluded.filter((t) => !primaryNames.includes(t));
    if (fkAdded.length > 0) {
      onProgress({ phase: "fk-walking", depthLevel: 1, tablesAdded: fkAdded });
    }

    for (const t of fkAdded) {
      schemas[t] = await env.introspect(conn, spec.schemaName, t);
    }

    const typeReport: TypeGuardReport = guardColumnTypes(schemas);
    if (typeReport.hasFatal) {
      throw new Error(formatTypeGuardError(typeReport));
    }

    const piiSuggestions: PiiSuggestion[] = [];
    if (spec.piiLevel === 2) {
      let scanned = 0;
      for (const tableName of fkResult.tablesIncluded) {
        for (const col of schemas[tableName] ?? []) {
          const samples = await env.pii.sampleColumn(
            conn, spec.schemaName, tableName, col.name, PII_SAMPLE_SIZE,
          );
          const det = env.pii.detect(col.name, samples);
          if (det) {
            piiSuggestions.push({
              table: tableName,
              column: col.name,
              signal: det.signal as PiiSuggestion["signal"],
              category: det.category,
              suggestedMask: det.defaultMask as PiiSuggestion["suggestedMask"],
              confidence: det.confidence,
            });
          }
        }
        scanned++;
      }
      onProgress({
        phase: "pii-scanning",
        tablesScanned: scanned,
        suggestionsCount: piiSuggestions.length,
      });
    }

    if (spec.dryRun) {
      // Wizard Step 4 (Review) calls buildSandbox with dryRun=true to populate
      // the PII review table without extracting/encrypting. We reuse the FK
      // closure + PII suggestions already gathered above and return early.
      //
      // Size/row estimates: this orchestrator does not query NUM_ROWS or
      // USER_SEGMENTS — that work belongs to sandbox.list-schema-tables (Task 1
      // of Plan 5b), which the wizard already invoked in Step 2. We emit zeros
      // here so the wizard prefers the per-table estimates from Step 2 over a
      // duplicated query. If/when the orchestrator gains row/byte tracking
      // before extraction, fill these in.
      const ttlExpiresAtDryRun = new Date(
        Date.now() + spec.ttlDays * 86_400_000,
      ).toISOString();
      onProgress({
        phase: "dry-run-done",
        fkClosureTables: fkResult.tablesIncluded,
        piiSuggestions,
        estimatedSizeBytes: 0,
        estimatedTotalRows: 0,
      });
      return {
        outPath: "",
        totalRows: 0,
        tableCount: fkResult.tablesIncluded.length,
        piiSuggestionsApplied: 0,
        ttlExpiresAt: ttlExpiresAtDryRun,
      };
    }

    const rowsByTable: Record<string, Record<string, unknown>[]> = {};
    let totalRows = 0;
    for (const tableName of fkResult.tablesIncluded) {
      const filter = spec.primaryTables.find((p) => p.name === tableName);
      const rows = await env.extractRows(
        conn, spec.schemaName, tableName, filter?.whereClause, filter?.rowCap,
      );
      rowsByTable[tableName] = rows;
      totalRows += rows.length;
      onProgress({ phase: "extracting", table: tableName, rowCount: rows.length });
    }

    // Phase E: PL/SQL discovery
    onProgress({ phase: "plsql-discovering", tablesScanned: fkResult.tablesIncluded.length });
    const { discoverPlsql } = await import("./discoverPlsql");
    const walker = (owner: string, names: string[]) =>
      env.discoverDependencies(conn, owner, names);
    const discovered = await discoverPlsql(walker, spec.schemaName, fkResult.tablesIncluded);

    // Phase F: apply manual exclusions from spec.excludedPlsql
    const excludedKey = (k: string, o: string, n: string) => `${k}:${o}:${n}`;
    const excludedSet = new Set(
      (spec.excludedPlsql ?? []).map((e) => excludedKey(e.kind, e.owner.toUpperCase(), e.name.toUpperCase())),
    );
    const filteredObjects = discovered.objects.filter(
      (o) => !excludedSet.has(excludedKey(o.kind, o.owner, o.name)),
    );

    // Phase G: DDL extraction with progress.
    // Bind extractDdl to the build connection so headless / non-IDE invocations
    // don't get routed through the interactive-session-only objectDdl path.
    const { extractPlsqlDdl } = await import("./extractPlsqlDdl");
    const ddlExtractor = (i: { kind: import("./discoverPlsql").ObjectKind; owner: string; name: string }) =>
      env.extractDdl(conn, i);
    const ddlResult = await extractPlsqlDdl(
      ddlExtractor,
      filteredObjects,
      ({ done, total }) => onProgress({ phase: "plsql-extracting", objectsTotal: total, objectsDone: done }),
    );

    onProgress({ phase: "packing-vsk", bytes: 0 });
    const ttlExpiresAt = new Date(Date.now() + spec.ttlDays * 86_400_000).toISOString();
    const manifest = {
      builtAt: new Date().toISOString(),
      sourceId: spec.connectionId,
      schemaName: spec.schemaName,
      ttlExpiresAt,
      tables: fkResult.tablesIncluded.map((tn) => ({
        name: tn,
        rowCount: rowsByTable[tn]?.length ?? 0,
        columns: (schemas[tn] ?? []).map((c) => ({
          name: c.name,
          type: c.dataType,
          nullable: c.nullable,
        })),
      })),
      piiMasks: piiSuggestions.map((s) => ({
        table: s.table,
        column: s.column,
        maskType: s.suggestedMask,
      })),
      engineVersion: MANIFEST_ENGINE_VERSION,
      dataFormat: MANIFEST_DATA_FORMAT,
      plsqlObjectCount: ddlResult.objectRows.length,
      skippedObjects: ddlResult.skipped,
      typeWarnings: typeReport.issues
        .filter((i) => !i.fatal)
        .map((i) => ({ table: i.table, column: i.column, oracleType: i.oracleType, message: i.message })),
    };

    onProgress({ phase: "encrypting", recipientCount: 1 });
    // validateSpec already enforced these for !dryRun; re-narrow for TS now
    // that they're optional on the spec type.
    const ownerAccount = spec.ownerAccount as string;
    const outPath = spec.outPath as string;
    const { contentKey, envelope } = await env.sealEnvelopeForOwner(ownerAccount);
    try {
      await env.writeEncryptedVskAt(outPath, manifest, rowsByTable, contentKey, envelope, {
        objectRows: ddlResult.objectRows,
        sourceRows: ddlResult.sourceRows,
        dependencies: discovered.dependencies,
      });
    } finally {
      // SDR-S-004: zero the symmetric key deterministically so a memory
      // dump shortly after build completion can't recover it. The key
      // returned from sealEnvelopeForOwner is no longer needed once the
      // .vsk file is written (the on-disk envelope holds the
      // public-key-encrypted copy).
      contentKey.fill(0);
    }

    const result: SandboxBuildResult = {
      outPath,
      totalRows,
      tableCount: fkResult.tablesIncluded.length,
      piiSuggestionsApplied: piiSuggestions.length,
      ttlExpiresAt,
    };
    onProgress({ phase: "done", outPath, totalRows, manifest: result });
    return result;
  } finally {
    try {
      await conn.close();
    } catch (closeErr) {
      // Don't mask the primary failure. Stderr is fine for v1; Task 12's
      // JSON-RPC handler can route this through the proper log channel.
      process.stderr.write(
        `[sandbox.build] connection close failed: ${(closeErr as Error).message}\n`,
      );
    }
  }
}

function validateSpec(spec: SandboxBuildSpec): void {
  if (spec.primaryTables.length === 0) {
    throw new Error("buildSandbox: primary tables list must not be empty");
  }
  if (spec.piiLevel !== 0 && spec.piiLevel !== 1 && spec.piiLevel !== 2) {
    throw new Error(`buildSandbox: invalid piiLevel ${spec.piiLevel} (must be 0, 1, or 2)`);
  }
  if (
    !Number.isInteger(spec.ttlDays) ||
    spec.ttlDays < TTL_MIN_DAYS ||
    spec.ttlDays > TTL_MAX_DAYS
  ) {
    throw new Error(
      `buildSandbox: invalid ttlDays ${spec.ttlDays} (must be integer ${TTL_MIN_DAYS}..${TTL_MAX_DAYS})`,
    );
  }
  // outPath + ownerAccount are only required for the real build (encrypt + write).
  // The Plan 5b wizard's Step 4 calls this with dryRun=true to populate the
  // PII review table, with no outPath/ownerAccount to supply (the dryRun branch
  // returns before sealEnvelopeForOwner / writeEncryptedVskAt run).
  if (!spec.dryRun) {
    if (typeof spec.outPath !== "string" || spec.outPath.trim().length === 0) {
      throw new Error("buildSandbox: outPath must be a non-empty string");
    }
    if (typeof spec.ownerAccount !== "string" || spec.ownerAccount.trim().length === 0) {
      throw new Error("buildSandbox: ownerAccount must be a non-empty string");
    }
  }
  if (typeof spec.connectionId !== "string" || spec.connectionId.trim().length === 0) {
    throw new Error("buildSandbox: connectionId must be a non-empty string");
  }
  // schemaName + table-name allowlist via quoteIdent (throws on bad input)
  quoteIdent(spec.schemaName);
  for (const t of spec.primaryTables) {
    quoteIdent(t.name);
  }
  if (spec.fkWalkDepth !== undefined) {
    if (
      !Number.isInteger(spec.fkWalkDepth) ||
      spec.fkWalkDepth < FK_WALK_DEPTH_MIN ||
      spec.fkWalkDepth > FK_WALK_DEPTH_MAX
    ) {
      throw new Error(
        `buildSandbox: invalid fkWalkDepth ${spec.fkWalkDepth} (must be integer ${FK_WALK_DEPTH_MIN}..${FK_WALK_DEPTH_MAX})`,
      );
    }
  }
}

// MUST match KEYSTORE_SERVICE in sandbox-cloud/handlers.ts. The build's
// sealEnvelopeForOwner stores under this service; the publish/grant/pull
// handlers load from the same service to recover the symmetric key.
// They were "veesker-cl" vs "veesker-engine" (mismatch) until 2026-05-02
// — symptom: publish failed with "ciphertext cannot be decrypted using
// that key" because seal/open used keys from different keyring entries.
// Exported so tests can seed the keystore under the same string the
// build path actually uses, catching future drift before it ships.
export const KEYRING_SERVICE = "veesker-engine";

/**
 * Build a real BuildEnv that wires to oracledb + @veesker/engine.
 * Caller supplies the resolved Oracle connection config (the desktop
 * already knows how to fetch this from the CL connection store).
 *
 * Plan 7 republish path: when `options.existingContentKey` and
 * `options.ownerKp` are provided, sealEnvelopeForOwner skips the
 * randomKey() + keychain auto-provision steps and instead reseals a
 * fresh envelope using the SAME contentKey recovered from the existing
 * sandbox envelope. This keeps prior recipient envelopes valid (their
 * sealed_content_key still decrypts to the same symmetric key) while
 * replacing the .vsk blob with refreshed source data.
 */
export function makeProductionBuildEnv(
  config: OracleConnectionConfig,
  options?: {
    existingContentKey?: Uint8Array;
    ownerKp?: { publicKey: Uint8Array; privateKey: Uint8Array };
  },
): BuildEnv {
  return {
    openConnection: async () => openOracleConnection(config),
    introspect: (conn, owner, table) =>
      introspectTable(conn as oracledb.Connection, owner, table),
    fkSingleHop: (conn, owner, tables) =>
      fkSingleHop(conn as oracledb.Connection, owner, tables),
    extractRows: (conn, owner, table, where, cap) =>
      orchestratorExtractRows(conn as oracledb.Connection, owner, table, where, cap),
    writeEncryptedVskAt: async (outPath, manifest, rowsByTable, contentKey, envelope, plsql) => {
      type ManifestShape = {
        tables: Array<{
          name: string;
          columns: Array<{ name: string; type: string; nullable: boolean }>;
        }>;
      };
      const m = manifest as ManifestShape;
      const host = await DuckDBHost.openInMemory();
      try {
        // Table-name normalization: DuckDB quoted identifiers are
        // case-sensitive, but Oracle delivers names in uppercase
        // canonically. We normalize to lowercase for the staged DuckDB
        // schema. The manifest stores the ORIGINAL Oracle case (so
        // viewer UIs show familiar names). The .vsk reader (Plan 4
        // member-side / Plan 7 query path) MUST apply the same
        // .toLowerCase() when running queries against the staged
        // DuckDB tables. Track this contract — breaking it produces
        // silent "table not found" errors at read time.
        for (const [tableName, rows] of Object.entries(rowsByTable)) {
          const cols = m.tables.find(
            (t) => t.name.toUpperCase() === tableName.toUpperCase(),
          )?.columns ?? [];
          if (cols.length === 0) continue;
          const colDdl = cols.map((c) => {
            const safeName = c.name.replace(/"/g, '""');
            const nullClause = c.nullable ? "" : " NOT NULL";
            const duckType = mapOracleType(c.type);
            return `"${safeName}" ${duckType}${nullClause}`;
          }).join(", ");
          await host.exec(`CREATE TABLE "${tableName.toLowerCase()}" (${colDdl})`);

          for (const row of rows) {
            const colNames = cols.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
            const colValues = cols.map((c) => sqlLiteral(row[c.name])).join(", ");
            await host.exec(
              `INSERT INTO "${tableName.toLowerCase()}" (${colNames}) VALUES (${colValues})`,
            );
          }
        }
        // v0.2.0: load __vsk_* tables alongside user tables so the engine
        // writer picks them up. The manifest already holds plsqlObjectCount
        // + skippedObjects; the actual DDL rows live in __vsk_source.
        if (plsql) {
          await host.exec(
            `CREATE TABLE "__vsk_objects" (kind VARCHAR NOT NULL, owner VARCHAR NOT NULL, name VARCHAR NOT NULL, status VARCHAR NOT NULL, ddl_size_bytes BIGINT NOT NULL, extracted_at TIMESTAMP NOT NULL, PRIMARY KEY (kind, owner, name))`,
          );
          for (const r of plsql.objectRows) {
            await host.exec(
              `INSERT INTO "__vsk_objects" VALUES (${sqlLiteral(r.kind)}, ${sqlLiteral(r.owner)}, ${sqlLiteral(r.name)}, ${sqlLiteral(r.status)}, ${sqlLiteral(r.ddl_size_bytes)}, TIMESTAMP ${sqlLiteral(r.extracted_at)})`,
            );
          }
          await host.exec(
            `CREATE TABLE "__vsk_source" (kind VARCHAR NOT NULL, owner VARCHAR NOT NULL, name VARCHAR NOT NULL, ddl TEXT, spec TEXT, body TEXT, PRIMARY KEY (kind, owner, name))`,
          );
          for (const r of plsql.sourceRows) {
            await host.exec(
              `INSERT INTO "__vsk_source" VALUES (${sqlLiteral(r.kind)}, ${sqlLiteral(r.owner)}, ${sqlLiteral(r.name)}, ${sqlLiteral(r.ddl)}, ${sqlLiteral(r.spec)}, ${sqlLiteral(r.body)})`,
            );
          }
          await host.exec(
            `CREATE TABLE "__vsk_dependencies" (kind VARCHAR NOT NULL, owner VARCHAR NOT NULL, name VARCHAR NOT NULL, ref_kind VARCHAR NOT NULL, ref_owner VARCHAR NOT NULL, ref_name VARCHAR NOT NULL, ref_status VARCHAR NOT NULL)`,
          );
          for (const r of plsql.dependencies) {
            await host.exec(
              `INSERT INTO "__vsk_dependencies" VALUES (${sqlLiteral(r.kind)}, ${sqlLiteral(r.owner)}, ${sqlLiteral(r.name)}, ${sqlLiteral(r.refKind)}, ${sqlLiteral(r.refOwner)}, ${sqlLiteral(r.refName)}, ${sqlLiteral(r.refStatus)})`,
            );
          }
        }
        await writeEncryptedVsk(host, outPath, manifest as VskManifest, contentKey, envelope);
      } finally {
        await host.close();
      }
    },
    sealEnvelopeForOwner: async (ownerAccount) => {
      await sodiumReady();
      // Plan 7 republish override: when an existing contentKey + owner
      // keypair were supplied, reseal using the SAME contentKey so prior
      // recipient envelopes still decrypt. ownerAccount is intentionally
      // unused on this branch (the caller already resolved the keypair).
      if (options?.existingContentKey && options?.ownerKp) {
        const kp = options.ownerKp;
        const ownerPub = kp.publicKey;
        const envelope = await sealEnvelope(
          options.existingContentKey,
          ownerPub,
          { publicKey: ownerPub, privateKey: kp.privateKey },
        );
        return { contentKey: options.existingContentKey, envelope };
      }
      const store = new OsKeyringStore(KEYRING_SERVICE, ownerAccount);
      let priv = await store.getPrivateKey();
      if (!priv) {
        // Auto-provision an owner keypair on first build. Plan 5 Wizard
        // surfaces this in the UI so the user knows it's happening.
        const kp = await generateKeypair();
        await store.setPrivateKey(kp.privateKey);
        // Defensive readback: if the keychain returned null due to a
        // transient read error rather than a genuinely empty slot, we'd
        // silently rotate keys and orphan all prior .vsk files. Verify
        // the write took and matches what we just stored.
        const verify = await store.getPrivateKey();
        if (!verify) {
          throw new Error(
            "sealEnvelopeForOwner: keychain write succeeded but read-back returned null — refusing to use a key we cannot persistently retrieve",
          );
        }
        if (verify.length !== kp.privateKey.length) {
          throw new Error(
            "sealEnvelopeForOwner: keychain read-back length mismatch — refusing to use a possibly-corrupted key",
          );
        }
        for (let i = 0; i < verify.length; i++) {
          if (verify[i] !== kp.privateKey[i]) {
            throw new Error(
              "sealEnvelopeForOwner: keychain read-back content mismatch — an existing key likely exists but was unreadable; refusing to overwrite",
            );
          }
        }
        priv = kp.privateKey;
      }
      const ownerPub = publicKeyFromPrivate(priv);
      const ownerKp = { publicKey: ownerPub, privateKey: priv };
      const contentKey = randomKey();
      // SELF-SEAL (v1): the envelope is sealed for the owner's own pubkey.
      // Plan 3 (BYOC upload + member envelopes) re-encrypts contentKey for
      // each member's pubkey separately. Do NOT change the sender key
      // here — the owner-private→owner-public ECDH is intentional and
      // backward-compatible with all v1 .vsk files.
      const envelope = await sealEnvelope(contentKey, ownerPub, ownerKp);
      return { contentKey, envelope };
    },
    pii: {
      sampleColumn: async (conn, owner, table, column, n) =>
        orchestratorSampleColumn(conn as oracledb.Connection, owner, table, column, n),
      detect: detectColumnPii,
    },
    discoverDependencies: (conn, schema, names) =>
      discoverDependenciesOnce(conn as oracledb.Connection, schema, names),
    extractDdl: (conn, i) =>
      extractObjectDdl(conn as oracledb.Connection, {
        owner: i.owner,
        objectType: i.kind,
        objectName: i.name,
      }),
  };
}

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "'NaN'::DOUBLE";
    if (v === Infinity) return "'inf'::DOUBLE";
    if (v === -Infinity) return "'-inf'::DOUBLE";
    return String(v);
  }
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) {
      // Invalid Date — emit NULL with a stderr warning so the bad row
      // doesn't abort the build, but the issue is visible in logs.
      process.stderr.write("[sandbox.build] sqlLiteral: invalid Date encountered, emitting NULL\n");
      return "NULL";
    }
    return `TIMESTAMP '${v.toISOString().slice(0, 19).replace("T", " ")}'`;
  }
  if (v instanceof Uint8Array) {
    // Buffer extends Uint8Array — covers oracledb's BLOB/RAW returns.
    // Emit a DuckDB hex literal: X'<hex>'. The string-default branch
    // would have produced '[object Buffer]' (silent corruption).
    let hex = "";
    for (let i = 0; i < v.length; i++) {
      hex += v[i]!.toString(16).padStart(2, "0");
    }
    return `X'${hex}'`;
  }
  // Strip null bytes BEFORE quote-doubling. DuckDB's parser truncates
  // at \x00 and reports "unterminated quoted string", which would abort
  // the whole build on a single bad row.
  return `'${String(v).replace(/\x00/g, "").replace(/'/g, "''")}'`;
}
