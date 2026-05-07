<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { DestructiveOp } from "$lib/sql-safety";

  type Props = {
    sql: string;
    ops: DestructiveOp[];
    onConfirm: () => void;
    onCancel: () => void;
    env?: "dev" | "staging" | "prod";
    onPreview?: () => Promise<{
      estimatedRows: number | null;
      timedOut: boolean;
      warning?: string;
      tableName?: string;
    }>;
  };
  let { sql, ops, onConfirm, onCancel, env, onPreview }: Props = $props();

  const worstSeverity = $derived(
    ops.some((o) => o.severity === "critical")
      ? "critical"
      : ops.some((o) => o.severity === "destructive")
        ? "destructive"
        : "warning"
  );

  const severityLabel: Record<string, string> = {
    critical: "CRITICAL",
    destructive: "DESTRUCTIVE",
    warning: "WARNING",
  };

  let previewState: "idle" | "loading" | "done" | "error" = $state("idle");
  let estimatedRows: number | null = $state(null);
  let previewTimedOut = $state(false);
  let previewWarning: string | undefined = $state(undefined);
  let previewReady = $state(false);
  let confirming = $state(false);

  $effect(() => {
    if (!onPreview) { previewReady = true; return; }
    previewState = "loading";
    onPreview().then((result) => {
      estimatedRows = result.estimatedRows;
      previewTimedOut = result.timedOut;
      previewWarning = result.warning;
      previewState = "done";
      previewReady = true;
    }).catch(() => {
      previewState = "error";
      previewReady = true;
    });
  });
</script>

<dialog
  class="modal"
  open
  onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
  onkeydown={(e) => { if (e.key === "Escape") onCancel(); }}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal-box"
    role="document"
    onkeydown={(e) => e.stopPropagation()}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="modal-header" class:critical={worstSeverity === "critical"} class:destructive={worstSeverity === "destructive"} class:warning={worstSeverity === "warning"}>
      <span class="severity-icon">{worstSeverity === "critical" ? "⛔" : worstSeverity === "destructive" ? "⚠️" : "⚡"}</span>
      <span class="modal-title">{severityLabel[worstSeverity]} — Confirm Execution</span>
      <button class="modal-close" onclick={onCancel} aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="ops-list">
        {#each ops as op (op.keyword)}
          <div class="op-row">
            <span class="op-badge" class:badge-critical={op.severity === "critical"} class:badge-destructive={op.severity === "destructive"} class:badge-warning={op.severity === "warning"}>
              {op.keyword}
            </span>
            <span class="op-desc">{op.description}</span>
          </div>
        {/each}
      </div>
      <div class="sql-preview-label">SQL to be executed:</div>
      <pre class="sql-preview">{sql}</pre>
      {#if onPreview}
        <div class="dry-run-row">
          {#if previewState === "loading"}
            <span class="dry-run-spinner"></span>
            <span class="dry-run-label">Checking affected rows...</span>
          {:else if previewTimedOut}
            <span class="dry-run-label">Could not estimate rows (timed out)</span>
          {:else if previewWarning === "merge-not-analyzable"}
            <span class="dry-run-label">MERGE — row estimate not available</span>
          {:else if estimatedRows !== null}
            <span class="dry-run-label">Estimated rows affected:</span>
            <span
              class="dry-run-count"
              class:count-critical={estimatedRows > 10000}
              class:count-warn={estimatedRows > 1000 && estimatedRows <= 10000}
              class:count-ok={estimatedRows <= 1000}
            >
              {estimatedRows.toLocaleString()}
            </span>
          {/if}
        </div>
      {/if}
      <p class="commit-note">COMMIT and ROLLBACK are never applied automatically — only via explicit button or script command.</p>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick={onCancel}>Cancel</button>
      <button
        class="btn-execute"
        onclick={async () => {
          confirming = true;
          let ok = false;
          try {
            ok = await invoke<boolean>("unsafe_dml_confirm", { summary: sql.slice(0, 300) });
          } finally {
            confirming = false;
          }
          if (ok) onConfirm();
        }}
        disabled={confirming || (env === "prod" && !previewReady)}
      >
        {#if confirming}
          Confirming…
        {:else if env === "prod" && !previewReady}
          Checking...
        {:else}
          Execute Anyway
        {/if}
      </button>
    </div>
  </div>
</dialog>

<style>
  .modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    border: none; padding: 0; z-index: 300;
  }
  .modal-box {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: 8px; width: 520px; max-width: 94vw; max-height: 82vh;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .modal-header {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
  }
  .modal-header.critical  { background: rgba(179,62,31,0.12); }
  .modal-header.destructive { background: rgba(179,120,31,0.10); }
  .modal-header.warning   { background: rgba(200,160,0,0.08); }
  .severity-icon { font-size: 16px; }
  .modal-title { flex: 1; font-size: 12px; font-weight: 700; color: var(--text-primary); letter-spacing: 0.05em; }
  .modal-close { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--text-muted); padding: 0 4px; }
  .modal-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .ops-list { display: flex; flex-direction: column; gap: 6px; }
  .op-row { display: flex; align-items: center; gap: 8px; }
  .op-badge {
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
    padding: 2px 6px; border-radius: 3px; white-space: nowrap;
  }
  .badge-critical    { background: rgba(179,62,31,0.15); color: #7a2a14; }
  .badge-destructive { background: rgba(179,120,31,0.15); color: #7a4214; }
  .badge-warning     { background: rgba(200,160,0,0.12); color: #6b5600; }
  .op-desc { font-size: 12px; color: var(--text-muted); }
  .sql-preview-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .sql-preview {
    background: var(--bg-surface-alt); border: 1px solid var(--border);
    border-radius: 4px; padding: 10px 12px;
    font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 11px;
    color: var(--text-primary); overflow-y: auto; max-height: 300px;
    white-space: pre-wrap; word-break: break-word; margin: 0;
  }
  .commit-note {
    font-size: 11px; color: var(--text-muted); font-style: italic;
    border-top: 1px solid var(--border); padding-top: 10px; margin: 0;
  }
  .modal-footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px; border-top: 1px solid var(--border);
  }
  .btn-cancel, .btn-execute {
    padding: 6px 18px; border-radius: 5px; font-size: 12px; cursor: pointer; border: none;
  }
  .btn-cancel { background: var(--bg-surface-alt); color: var(--text-primary); border: 1px solid var(--border); }
  .btn-execute { background: #b33e1f; color: #fff; font-weight: 600; }
  .btn-execute:hover:not(:disabled) { background: #8c2f17; }
  .btn-execute:disabled { opacity: 0.6; cursor: default; }
  .dry-run-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: 4px;
    background: var(--bg-surface-alt); border: 1px solid var(--border);
    font-size: 12px; color: var(--text-muted);
  }
  .dry-run-count { font-weight: 700; font-size: 13px; }
  .count-critical { color: #b33e1f; }
  .count-warn     { color: #d97706; }
  .count-ok       { color: var(--text-muted); }
  .dry-run-spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--text-muted);
    animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
