<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  type Props = {
    riskLevel: "destructive_ddl" | "ddl";
    statements: string[];
    env: string;
    onConfirm: () => void;
    onCancel: () => void;
  };
  let { riskLevel, statements, env, onConfirm, onCancel }: Props = $props();

  const isDestructive = riskLevel === "destructive_ddl";
  const isProd = env === "prod";

  let understood = $state(false);
  let confirming = $state(false);

  async function handleConfirm() {
    confirming = true;
    try {
      onConfirm();
    } finally {
      confirming = false;
    }
  }
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
    <div class="modal-header" class:destructive={isDestructive} class:ddl={!isDestructive}>
      <span class="header-icon">{isDestructive ? "⛔" : "⚠️"}</span>
      <span class="modal-title">
        {isDestructive ? "DESTRUCTIVE DDL" : "DDL Statement"} — Schema Change
      </span>
      {#if isProd}
        <span class="prod-badge">PRODUCTION</span>
      {/if}
      <button class="modal-close" onclick={onCancel} aria-label="Close">×</button>
    </div>

    <div class="modal-body">
      {#if isProd}
        <div class="prod-warning">
          You are executing a DDL statement on a <strong>PRODUCTION</strong> database.
          Schema changes are immediate and may affect running applications.
        </div>
      {/if}

      <div class="statements-label">
        {statements.length === 1 ? "Statement to execute:" : `${statements.length} DDL statements to execute:`}
      </div>
      <div class="statements-list">
        {#each statements as s, i}
          <details open={i === 0}>
            <summary class="stmt-summary">
              {s.split('\n')[0].slice(0, 100)}{s.length > 100 ? '…' : ''}
            </summary>
            <pre class="stmt-full">{s}</pre>
          </details>
        {/each}
      </div>

      <div class="window-notice">
        A <strong>5-minute</strong> confirmation window will open.
        Subsequent DDL in this session will not require re-confirmation within that period.
      </div>

      {#if isDestructive}
        <div class="destructive-warning">
          <strong>Irreversible:</strong> DROP and TRUNCATE operations permanently destroy data or schema objects.
          This cannot be undone by ROLLBACK.
        </div>
        <label class="understood-check">
          <input type="checkbox" bind:checked={understood} />
          I understand this DDL is irreversible
        </label>
      {:else}
        <p class="confirm-note">
          Confirm you intend to execute this DDL on <strong>{env}</strong>.
        </p>
      {/if}
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" onclick={onCancel}>Cancel</button>
      <button
        class="btn-execute"
        class:destructive={isDestructive}
        onclick={handleConfirm}
        disabled={confirming || (isDestructive && !understood)}
      >
        {#if confirming}
          Opening window…
        {:else if isDestructive}
          Execute Destructive DDL
        {:else}
          Execute DDL
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
  .modal-header.destructive { background: rgba(179,62,31,0.12); }
  .modal-header.ddl         { background: rgba(200,140,0,0.10); }
  .header-icon { font-size: 16px; }
  .modal-title { flex: 1; font-size: 12px; font-weight: 700; color: var(--text-primary); letter-spacing: 0.05em; }
  .prod-badge {
    font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    padding: 2px 6px; border-radius: 3px;
    background: rgba(179,62,31,0.20); color: #7a2a14;
  }
  .modal-close { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--text-muted); padding: 0 4px; }
  .modal-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .prod-warning {
    padding: 10px 12px; border-radius: 5px;
    background: rgba(179,62,31,0.08); border: 1px solid rgba(179,62,31,0.25);
    font-size: 12px; color: var(--text-primary);
  }
  .statements-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .statements-list { display: flex; flex-direction: column; gap: 4px; }
  details { border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .stmt-summary {
    padding: 7px 10px; cursor: pointer;
    font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 11px;
    color: var(--text-primary); background: var(--bg-surface-alt);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    user-select: none; list-style: none;
  }
  .stmt-summary::marker, .stmt-summary::-webkit-details-marker { display: none; }
  details[open] .stmt-summary { border-bottom: 1px solid var(--border); }
  .stmt-full {
    margin: 0; padding: 10px 12px;
    font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 11px;
    color: var(--text-primary); background: var(--bg-surface-alt);
    white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;
  }
  .window-notice {
    font-size: 12px; color: var(--text-muted);
    padding: 8px 10px; border-radius: 4px;
    background: var(--bg-surface-alt); border: 1px solid var(--border);
  }
  .destructive-warning {
    padding: 10px 12px; border-radius: 5px;
    background: rgba(179,62,31,0.08); border: 1px solid rgba(179,62,31,0.25);
    font-size: 12px; color: var(--text-primary);
  }
  .understood-check {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-primary); cursor: pointer;
  }
  .understood-check input { width: 14px; height: 14px; cursor: pointer; }
  .confirm-note { font-size: 12px; color: var(--text-muted); margin: 0; }
  .modal-footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px; border-top: 1px solid var(--border);
  }
  .btn-cancel, .btn-execute {
    padding: 6px 18px; border-radius: 5px; font-size: 12px; cursor: pointer; border: none;
  }
  .btn-cancel { background: var(--bg-surface-alt); color: var(--text-primary); border: 1px solid var(--border); }
  .btn-execute { background: #d97706; color: #fff; font-weight: 600; }
  .btn-execute.destructive { background: #b33e1f; }
  .btn-execute:hover:not(:disabled) { opacity: 0.88; }
  .btn-execute:disabled { opacity: 0.6; cursor: default; }
</style>
