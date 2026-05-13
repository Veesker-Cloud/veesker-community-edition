import type { VskMaskType } from "@veesker/engine";

/** Configuration for one sandbox build. */
export interface SandboxBuildSpec {
  /** Existing CL connection identifier (from CL's connection store). */
  connectionId: string;
  /** Schema/owner the sandbox is built from (e.g. "ORDERS_OWNER"). */
  schemaName: string;
  /** Display name for the sandbox; informational only. */
  sandboxName: string;
  /** TTL in days from now until D0 purge. Min 1, max 90. */
  ttlDays: number;
  /** PII detection level. v1 supports 0/1/2; level 3 is Plan 6. */
  piiLevel: 0 | 1 | 2;
  /** Owner's email, used as the keyring account for crypto. Required for the
   *  real (non-dryRun) build only — the dryRun path returns before
   *  sealEnvelopeForOwner runs. The Plan 5b wizard wrappers leave this unset
   *  and the sidecar handler injects the rpc envelope's ownerAccount when
   *  needed. */
  ownerAccount?: string;
  /** Tables explicitly requested by the owner. FK walk expands this. */
  primaryTables: PrimaryTableSpec[];
  /** Maximum FK walk depth (default 2). */
  fkWalkDepth?: number;
  /** When true, run introspect + FK walk + PII scan and stop. No extraction,
   *  no encrypt, no .vsk write. Used by the publish wizard's Step 4 (Review)
   *  to populate the PII review table without doing the heavy work twice. */
  dryRun?: boolean;
  /** Output path for the encrypted .vsk. Required for the real build only —
   *  the dryRun path returns before writeEncryptedVskAt runs. */
  outPath?: string;
  /** v0.2.0: PL/SQL objects discovered by the wizard's discover step that the
   *  user explicitly opted out of including. The build phase F applies this
   *  filter before phase G's DDL extraction. */
  excludedPlsql?: Array<{ kind: string; owner: string; name: string }>;
}

export interface PrimaryTableSpec {
  /** Oracle table name (uppercase). */
  name: string;
  /**
   * Optional Oracle WHERE clause body (no leading "WHERE"). Applied per
   * primary table during extraction.
   *
   * SECURITY NOTE: this string is interpolated raw into SQL by
   * buildExtractSql. It must only originate from the sandbox owner who
   * authored this SandboxBuildSpec. Do NOT route end-user-supplied
   * filter strings here without a separate validation/allowlist layer.
   */
  whereClause?: string;
  /** Optional row cap (LIMIT N applied to the SELECT). */
  rowCap?: number;
}

/** Per-table FK relationship discovered during walk. */
export interface FkEdge {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

/** A column the PII detector flagged for masking. */
export interface PiiSuggestion {
  table: string;
  column: string;
  /** Detection signal that triggered the suggestion. */
  signal: "column-name" | "sample-value" | "both";
  /** Pattern category that matched (e.g. "email", "cpf", "phone-br"). */
  category: string;
  /** Suggested mask type. Owner can override before build. */
  suggestedMask: VskMaskType;
  /** Confidence score 0..1. */
  confidence: number;
}

/** Streamed progress event emitted during a build. Shape matches sidecar's
 *  existing JSON-RPC notification convention (see flow.ts for the pattern). */
export type BuildProgressEvent =
  | { phase: "starting"; spec: { sandboxName: string; primaryTableCount: number } }
  | { phase: "introspecting-schema"; tables: string[] }
  | { phase: "fk-walking"; depthLevel: number; tablesAdded: string[] }
  | { phase: "pii-scanning"; tablesScanned: number; suggestionsCount: number }
  | {
      phase: "dry-run-done";
      fkClosureTables: string[];
      piiSuggestions: PiiSuggestion[];
      estimatedSizeBytes: number;
      estimatedTotalRows: number;
    }
  | { phase: "extracting"; table: string; rowCount: number }
  | { phase: "packing-vsk"; bytes: number }
  | { phase: "encrypting"; recipientCount: number }
  | { phase: "done"; outPath: string; totalRows: number; manifest: SandboxBuildResult }
  | { phase: "error"; message: string; code?: string }
  | { phase: "plsql-discovering"; tablesScanned: number }
  | { phase: "plsql-extracting"; objectsTotal: number; objectsDone: number };

/** Final result returned by sandbox.build (also embedded in the "done" event). */
export interface SandboxBuildResult {
  outPath: string;
  totalRows: number;
  tableCount: number;
  piiSuggestionsApplied: number;
  ttlExpiresAt: string;
}

/** Lightweight table summary returned by sandbox.list-schema-tables. */
export interface SchemaTableInfo {
  /** Oracle table name, uppercase. */
  name: string;
  /** ALL_TABLES.NUM_ROWS — may be stale if optimizer stats not gathered. */
  rowCount: number | null;
  /** Estimated bytes from USER_SEGMENTS.bytes (actual allocated extents).
   *  Null if the connected user can't see USER_SEGMENTS for this segment, or
   *  the table has no allocated segment yet. The wizard publishes the
   *  owner's own schema, so cross-schema visibility isn't required here. */
  sizeBytesEst: number | null;
}

/** A table in the FK closure with its discovery depth + the FK that pulled it (if any). */
export interface FkClosureEntry {
  /** Oracle table name, uppercase. */
  name: string;
  /** Origin: 0 = explicit (in primaryTables); 1..N = FK hop depth. */
  depth: number;
  /** Which edge pulled this table (undefined for explicit primary tables). */
  viaFk?: {
    fromTable: string;
    fromColumns: string[];
    toColumns: string[];
  };
}

export interface FkClosureResult {
  /** Tables in BFS order (explicit first, then by depth ascending). */
  entries: FkClosureEntry[];
  /** Raw edges discovered during walk. */
  edges: import("./fk-walk").FkEdge[];
}
