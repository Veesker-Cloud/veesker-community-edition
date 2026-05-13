// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type {
  FkClosureResult,
  PiiSuggestion,
  PrimaryTableSpec,
  SchemaTableInfo,
} from "../sandbox";

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface RecipientChip {
  email: string;
  userId: string | null;
  pubkeyOk: boolean;
}

export interface PublishWizardState {
  currentStep: WizardStep;
  /** "create" is the default brand-new publish. "republish" is set when
   *  the user came from a SandboxCard republish action — the source step
   *  pre-fills from the existing sandbox metadata and the publish step
   *  routes through `sandbox_republish` instead of `sandbox_publish`. */
  mode: "create" | "republish";
  /** Sandbox ID to republish; only meaningful when mode === "republish". */
  republishingSandboxId: string | null;
  source: {
    connectionId: string | null;
    schemaName: string | null;
    /** Set when Step 1 has confirmed via connection_sandbox_oracle_check that
     *  the keychain entry resolves. Gates canAdvance(). The actual password
     *  is resolved server-side per RPC and never exists in the renderer. */
    credsReady: boolean;
  };
  tables: {
    explicit: PrimaryTableSpec[];
    fkClosure: FkClosureResult["entries"];
    excluded: Set<string>;
    manual: string[];
    fkDepth: number;
    available: SchemaTableInfo[];
  };
  spec: {
    sandboxName: string;
    ttlDays: number;
    piiLevel: 0 | 1 | 2;
    recipients: RecipientChip[];
  };
  review: {
    piiSuggestions: PiiSuggestion[];
    piiOverrides: Map<string, string>;
    flaggedManually: PiiSuggestion[];
    estimatedSizeBytes: number;
    estimatedTotalRows: number;
    dryRunStatus: "idle" | "running" | "ok" | "error";
    dryRunError: string | null;
  };
  plsql: {
    discoveryStatus: "idle" | "running" | "ok" | "error";
    discoveryError: string | null;
    discovered: Array<{
      kind: "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE" | "VIEW";
      owner: string;
      name: string;
      refPath: string[];
    }>;
    excluded: Set<string>;
    estimatedTotalBytes: number;
  };
  publish: {
    phase: "idle" | "build" | "encrypt" | "upload" | "grant" | "done" | "error";
    progressLines: string[];
    sandboxId: string | null;
    grantResults: Map<string, "ok" | { error: string }>;
    error: string | null;
    /** Path of the last `.vsk` produced by a successful Build phase. Survives
     *  Upload/Grant failures so the user can retry from Upload without paying
     *  the cost of re-extracting from Oracle and re-encrypting. Cleared after
     *  Done (auto-cleanup deletes the file from disk anyway) and on full
     *  retry. `null` means there is no resumable build. */
    lastBuildOutPath: string | null;
    /** Live R2 upload progress, populated from `sandbox-upload-progress`
     *  Tauri events. Null until the upload phase actually emits its first
     *  tick; null again after retry or reset. */
    uploadProgress: { bytesUploaded: number; totalBytes: number } | null;
  };
}

const PROGRESS_LOG_MAX = 200;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export function createPublishWizard() {
  const state = $state<PublishWizardState>({
    currentStep: 1,
    mode: "create",
    republishingSandboxId: null,
    source: { connectionId: null, schemaName: null, credsReady: false },
    tables: {
      explicit: [],
      fkClosure: [],
      excluded: new Set(),
      manual: [],
      fkDepth: 2,
      available: [],
    },
    spec: { sandboxName: "", ttlDays: 7, piiLevel: 2, recipients: [] },
    review: {
      piiSuggestions: [],
      piiOverrides: new Map(),
      flaggedManually: [],
      estimatedSizeBytes: 0,
      estimatedTotalRows: 0,
      dryRunStatus: "idle",
      dryRunError: null,
    },
    plsql: {
      discoveryStatus: "idle",
      discoveryError: null,
      discovered: [],
      excluded: new Set(),
      estimatedTotalBytes: 0,
    },
    publish: {
      phase: "idle",
      progressLines: [],
      sandboxId: null,
      grantResults: new Map(),
      error: null,
      lastBuildOutPath: null,
      uploadProgress: null,
    },
  });

  function canAdvance(): boolean {
    switch (state.currentStep) {
      case 1:
        return state.source.connectionId !== null && state.source.credsReady;
      case 2:
        return state.tables.explicit.length >= 1;
      case 3:
        return (
          state.spec.sandboxName.trim() !== "" &&
          state.spec.ttlDays >= 1 &&
          state.spec.ttlDays <= 90
        );
      case 4:
        return state.review.dryRunStatus === "ok";
      case 5:
        return state.plsql.discoveryStatus === "ok" || state.plsql.discovered.length === 0;
      case 6:
        return false;
    }
  }

  function next(): void {
    if (!canAdvance()) return;
    if (state.currentStep < 6) {
      state.currentStep = (state.currentStep + 1) as WizardStep;
    }
  }

  function back(): void {
    if (state.currentStep > 1) {
      const leaving = state.currentStep;
      state.currentStep = (state.currentStep - 1) as WizardStep;
      // Leaving Step 4 backwards invalidates the dry-run review — the user is
      // about to edit something upstream (tables / spec / recipients). On the
      // next forward visit to Step 4 the review must re-fire so the user
      // doesn't publish against a stale PII suggestion list / FK closure.
      if (leaving === 4) {
        state.review.dryRunStatus = "idle";
        state.review.dryRunError = null;
        state.review.piiSuggestions = [];
        state.review.estimatedSizeBytes = 0;
        state.review.estimatedTotalRows = 0;
      }
      // Leaving Step 5 (PL/SQL Review) backwards wipes discovery so the
      // component re-fires on the next forward visit against the current
      // table selection (which the user may have changed via Back→Step 2).
      if (leaving === 5) {
        state.plsql.discoveryStatus = "idle";
        state.plsql.discovered = [];
        state.plsql.excluded = new Set();
        state.plsql.estimatedTotalBytes = 0;
      }
      // Leaving Step 6 (Publish) backwards must wipe publish output so the
      // error banner from a previous run doesn't flash on re-entry, and so a
      // stale lastBuildOutPath from one schema can't be uploaded under a
      // re-configured sandbox identity / recipient set on the next forward
      // visit. The orchestrator re-fires from scratch on Step 6 mount.
      if (leaving === 6) {
        softResetPublish();
      }
    }
  }

  function softResetPublish(): void {
    state.publish.phase = "idle";
    state.publish.error = null;
    state.publish.lastBuildOutPath = null;
    state.publish.uploadProgress = null;
    state.publish.progressLines = [];
    state.publish.grantResults.clear();
    state.publish.sandboxId = null;
  }

  function setSource(
    connectionId: string,
    schemaName: string,
    credsReady = false,
  ): void {
    const upperSchema = schemaName.toUpperCase();
    const schemaChanged =
      state.source.connectionId !== connectionId ||
      state.source.schemaName !== upperSchema;
    state.source = {
      connectionId,
      schemaName: upperSchema,
      credsReady,
    };
    // When the source schema changes, anything we've gathered against the old
    // schema is invalid — clear table picks, FK closure, manual additions,
    // exclusions, the Step 2 cache, and any dryRun review state. Otherwise
    // (re-confirming the same source after a back-and-forth) keep state.
    if (schemaChanged) {
      state.tables.explicit = [];
      state.tables.fkClosure = [];
      state.tables.excluded.clear();
      state.tables.manual = [];
      state.tables.available = [];
      state.review.dryRunStatus = "idle";
      state.review.dryRunError = null;
      state.review.piiSuggestions = [];
      state.review.estimatedSizeBytes = 0;
      state.review.estimatedTotalRows = 0;
      state.plsql.discoveryStatus = "idle";
      state.plsql.discovered = [];
      state.plsql.excluded = new Set();
      state.plsql.estimatedTotalBytes = 0;
      // Any in-flight publish state was tied to the previous schema (the
      // .vsk at lastBuildOutPath was extracted from it). Reusing it under a
      // new schema would upload the wrong bytes, so wipe everything.
      softResetPublish();
    }
  }

  function setCredsReady(ready: boolean): void {
    state.source.credsReady = ready;
  }

  function setAvailableTables(tables: SchemaTableInfo[]): void {
    state.tables.available = tables;
  }

  function addExplicitTable(name: string): void {
    const upper = name.toUpperCase();
    if (state.tables.explicit.some((t) => t.name === upper)) return;
    state.tables.explicit.push({ name: upper });
  }

  function removeExplicitTable(name: string): void {
    const upper = name.toUpperCase();
    state.tables.explicit = state.tables.explicit.filter((t) => t.name !== upper);
  }

  function setTableFilter(name: string, whereClause?: string, rowCap?: number): void {
    const upper = name.toUpperCase();
    const t = state.tables.explicit.find((x) => x.name === upper);
    if (!t) return;
    t.whereClause = whereClause?.trim() || undefined;
    t.rowCap = rowCap && rowCap > 0 ? rowCap : undefined;
  }

  function applyFkClosure(closure: FkClosureResult): void {
    state.tables.fkClosure = closure.entries;
  }

  function excludeTable(name: string): void {
    state.tables.excluded.add(name.toUpperCase());
  }

  function unexcludeTable(name: string): void {
    state.tables.excluded.delete(name.toUpperCase());
  }

  function addManual(name: string): void {
    const upper = name.toUpperCase();
    if (!state.tables.manual.includes(upper)) state.tables.manual.push(upper);
  }

  function removeManual(name: string): void {
    const upper = name.toUpperCase();
    state.tables.manual = state.tables.manual.filter((n) => n !== upper);
  }

  function setFkDepth(d: number): void {
    state.tables.fkDepth = clamp(d, 1, 5);
  }

  function effectiveTables(): { name: string; depth: number; origin: "explicit" | "fk" | "manual" }[] {
    const out: { name: string; depth: number; origin: "explicit" | "fk" | "manual" }[] = [];
    for (const t of state.tables.explicit) {
      if (state.tables.excluded.has(t.name)) continue;
      out.push({ name: t.name, depth: 0, origin: "explicit" });
    }
    for (const e of state.tables.fkClosure) {
      if (e.depth === 0) continue;
      if (state.tables.excluded.has(e.name)) continue;
      // FK walk can revisit a table the user already picked explicitly
      // (cycle in the schema, or two explicit picks both pointing at the
      // same parent). Explicit wins; skip the duplicate or {#each (t.name)}
      // throws each_key_duplicate.
      if (out.some((x) => x.name === e.name)) continue;
      out.push({ name: e.name, depth: e.depth, origin: "fk" });
    }
    for (const m of state.tables.manual) {
      if (state.tables.excluded.has(m)) continue;
      if (out.some((x) => x.name === m)) continue;
      out.push({ name: m, depth: 0, origin: "manual" });
    }
    return out;
  }

  function hasE2eExclusionWarning(): boolean {
    for (const e of state.tables.fkClosure) {
      if (e.depth === 0) continue;
      if (state.tables.excluded.has(e.name)) return true;
    }
    return false;
  }

  function setSpec(patch: { sandboxName?: string; ttlDays?: number; piiLevel?: 0 | 1 | 2 }): void {
    if (patch.sandboxName !== undefined) state.spec.sandboxName = patch.sandboxName;
    if (patch.ttlDays !== undefined) state.spec.ttlDays = clamp(patch.ttlDays, 1, 90);
    if (patch.piiLevel !== undefined) state.spec.piiLevel = patch.piiLevel;
  }

  function addRecipient(chip: RecipientChip): void {
    if (state.spec.recipients.some((r) => r.email === chip.email)) return;
    state.spec.recipients.push(chip);
  }

  function removeRecipient(email: string): void {
    state.spec.recipients = state.spec.recipients.filter((r) => r.email !== email);
  }

  function setPiiOverride(table: string, column: string, mask: string): void {
    state.review.piiOverrides.set(`${table.toUpperCase()}.${column.toUpperCase()}`, mask);
  }

  function setDryRunStatus(status: "idle" | "running" | "ok" | "error", error?: string): void {
    state.review.dryRunStatus = status;
    state.review.dryRunError = error ?? null;
  }

  function appendProgressLine(line: string): void {
    state.publish.progressLines.push(line);
    if (state.publish.progressLines.length > PROGRESS_LOG_MAX) {
      state.publish.progressLines.splice(0, state.publish.progressLines.length - PROGRESS_LOG_MAX);
    }
  }

  function setPublishPhase(phase: PublishWizardState["publish"]["phase"], error?: string): void {
    state.publish.phase = phase;
    state.publish.error = error ?? null;
  }

  function recordGrantResult(recipientKey: string, result: "ok" | { error: string }): void {
    // recipientKey is the recipient's email (canonical identity from the chip).
    // Earlier drafts mixed userId keys for granted vs email keys for skipped,
    // silently shadowing on collisions — keep this uniform.
    state.publish.grantResults.set(recipientKey, result);
  }

  function setSandboxId(id: string): void {
    state.publish.sandboxId = id;
  }

  function setLastBuildOutPath(outPath: string | null): void {
    state.publish.lastBuildOutPath = outPath;
  }

  function setUploadProgress(
    progress: { bytesUploaded: number; totalBytes: number } | null,
  ): void {
    state.publish.uploadProgress = progress;
  }

  function setPlsqlDiscovery(
    discovered: PublishWizardState["plsql"]["discovered"],
    estimatedTotalBytes: number,
  ): void {
    state.plsql.discovered = discovered;
    state.plsql.estimatedTotalBytes = estimatedTotalBytes;
    state.plsql.discoveryStatus = "ok";
    state.plsql.discoveryError = null;
    state.plsql.excluded = new Set();
  }

  function setPlsqlDiscoveryStatus(
    status: PublishWizardState["plsql"]["discoveryStatus"],
    error?: string,
  ): void {
    state.plsql.discoveryStatus = status;
    state.plsql.discoveryError = error ?? null;
  }

  function plsqlKey(kind: string, owner: string, name: string): string {
    return `${kind.toUpperCase()}:${owner.toUpperCase()}:${name.toUpperCase()}`;
  }

  // Svelte 5's $state proxy intercepts property writes but not Set mutations
  // via .add/.delete. Reassigning the entire Set on each mutation guarantees
  // template expressions like `excluded.has(k)` re-evaluate when the set
  // changes. Same pattern as sandboxes.svelte.ts.
  function togglePlsql(kind: string, owner: string, name: string): void {
    const k = plsqlKey(kind, owner, name);
    const next = new Set(state.plsql.excluded);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    state.plsql.excluded = next;
  }

  function unselectKind(kind: string): void {
    const next = new Set(state.plsql.excluded);
    for (const o of state.plsql.discovered) {
      if (o.kind === kind) next.add(plsqlKey(o.kind, o.owner, o.name));
    }
    state.plsql.excluded = next;
  }

  function selectKind(kind: string): void {
    const next = new Set(state.plsql.excluded);
    for (const o of state.plsql.discovered) {
      if (o.kind === kind) next.delete(plsqlKey(o.kind, o.owner, o.name));
    }
    state.plsql.excluded = next;
  }

  function getEffectiveExcludedPlsql(): Array<{ kind: string; owner: string; name: string }> {
    const out: Array<{ kind: string; owner: string; name: string }> = [];
    for (const k of state.plsql.excluded) {
      const [kind, owner, name] = k.split(":");
      if (kind && owner && name) out.push({ kind, owner, name });
    }
    return out;
  }

  function getEffectiveSelectedCount(): number {
    return state.plsql.discovered.length - state.plsql.excluded.size;
  }

  function reset(): void {
    state.currentStep = 1;
    state.mode = "create";
    state.republishingSandboxId = null;
    state.source = { connectionId: null, schemaName: null, credsReady: false };
    state.tables.explicit = [];
    state.tables.fkClosure = [];
    state.tables.excluded.clear();
    state.tables.manual = [];
    state.tables.fkDepth = 2;
    state.tables.available = [];
    state.spec.sandboxName = "";
    state.spec.ttlDays = 7;
    state.spec.piiLevel = 2;
    state.spec.recipients = [];
    state.review.piiSuggestions = [];
    state.review.piiOverrides.clear();
    state.review.flaggedManually = [];
    state.review.dryRunStatus = "idle";
    state.review.dryRunError = null;
    state.review.estimatedSizeBytes = 0;
    state.review.estimatedTotalRows = 0;
    state.plsql.discoveryStatus = "idle";
    state.plsql.discoveryError = null;
    state.plsql.discovered = [];
    state.plsql.excluded = new Set();
    state.plsql.estimatedTotalBytes = 0;
    softResetPublish();
  }

  return {
    get state() { return state; },
    canAdvance,
    next,
    back,
    setSource,
    setCredsReady,
    setAvailableTables,
    addExplicitTable,
    removeExplicitTable,
    setTableFilter,
    applyFkClosure,
    excludeTable,
    unexcludeTable,
    addManual,
    removeManual,
    setFkDepth,
    effectiveTables,
    hasE2eExclusionWarning,
    setSpec,
    addRecipient,
    removeRecipient,
    setPiiOverride,
    setDryRunStatus,
    setPlsqlDiscovery,
    setPlsqlDiscoveryStatus,
    togglePlsql,
    unselectKind,
    selectKind,
    getEffectiveExcludedPlsql,
    getEffectiveSelectedCount,
    appendProgressLine,
    setPublishPhase,
    recordGrantResult,
    setSandboxId,
    setLastBuildOutPath,
    setUploadProgress,
    softResetPublish,
    reset,
  };
}

export type PublishWizard = ReturnType<typeof createPublishWizard>;
