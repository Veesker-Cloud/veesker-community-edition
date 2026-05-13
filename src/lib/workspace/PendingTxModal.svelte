<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-cloud-edition
-->

<script lang="ts">
  // Item #4 Phase C — Pending TX modal (env-asymmetric).
  //
  // Behavior contract:
  //   - No dismiss via ESC or click-outside. Only the "Cancelar" button.
  //   - COMMIT ALL is disabled when any row is staging or prod (forces
  //     the user to decide per-row instead of bulk-committing prod).
  //   - Single-row N-ready: today the sidecar is single-session so the
  //     `connections` array has length 1, but the layout already
  //     iterates so Item #5 multi-conn drops in cleanly.
  //   - PROD: every row exposes a "Manter aberto" dropdown
  //     (30min/1h/2h/4h/8h, default 2h) that promises not to
  //     auto-rollback for the chosen window.
  //   - The 5-min idle tray notification ("TX PROD aguardando decisão
  //     há Xmin em CONN_X") is fired by the controller, not here.

  import type { TxModalDecision } from "$lib/workspace";

  export type ConnectionRow = {
    connectionId: string;
    connectionName: string;
    env: "local" | "dev" | "staging" | "prod";
    pendingStatements: number;
    lastTxId: string | null;
    lastModifyingType: "dml" | "ddl" | "plsql" | null;
  };

  type KeepOpenChoice = 30 | 60 | 120 | 240 | 480;

  export type PerRowDecision =
    | { kind: "commit" }
    | { kind: "rollback" }
    | { kind: "keep_open"; minutes: KeepOpenChoice };

  type Props = {
    connections: ConnectionRow[];
    triggerLabel?: string;
    onDecide: (decisions: Record<string, PerRowDecision>) => void;
    onCancel: () => void;
  };

  let { connections, triggerLabel, onDecide, onCancel }: Props = $props();

  const initialPerRow = $derived(
    Object.fromEntries(connections.map((c) => [c.connectionId, null])) as Record<
      string,
      PerRowDecision | null
    >,
  );
  const initialKeepOpen = $derived(
    Object.fromEntries(
      connections
        .filter((c) => c.env === "prod")
        .map((c) => [c.connectionId, 120 as KeepOpenChoice]),
    ) as Record<string, KeepOpenChoice>,
  );

  let perRow = $state<Record<string, PerRowDecision | null>>({});
  let keepOpenMinutes = $state<Record<string, KeepOpenChoice>>({});

  $effect(() => {
    perRow = { ...initialPerRow };
    keepOpenMinutes = { ...initialKeepOpen };
  });

  const hasStagingOrProd = $derived(
    connections.some((c) => c.env === "staging" || c.env === "prod"),
  );
  const allDecided = $derived(
    connections.every((c) => perRow[c.connectionId] !== null),
  );

  function commitAll() {
    if (hasStagingOrProd) return;
    const out: Record<string, PerRowDecision> = {};
    for (const c of connections) out[c.connectionId] = { kind: "commit" };
    onDecide(out);
  }
  function rollbackAll() {
    const out: Record<string, PerRowDecision> = {};
    for (const c of connections) out[c.connectionId] = { kind: "rollback" };
    onDecide(out);
  }
  function pickRow(connectionId: string, dec: PerRowDecision) {
    perRow[connectionId] = dec;
  }
  function applyDecisions() {
    if (!allDecided) return;
    const out: Record<string, PerRowDecision> = {};
    for (const c of connections) {
      const d = perRow[c.connectionId];
      if (d) out[c.connectionId] = d;
    }
    onDecide(out);
  }

  function envClass(env: ConnectionRow["env"]) {
    return `env-${env}`;
  }

  function _decisionLabel(dec: PerRowDecision | null): TxModalDecision | null {
    if (!dec) return null;
    if (dec.kind === "commit") return "tx_modal_commit";
    if (dec.kind === "rollback") return "tx_modal_rollback";
    return "tx_modal_keep_open";
  }
</script>

<div class="overlay" role="presentation" data-testid="pending-tx-overlay">
  <div
    class="modal"
    role="alertdialog"
    aria-labelledby="ptx-title"
    aria-describedby="ptx-desc"
    data-testid="pending-tx-modal"
  >
    <div class="head">
      <span class="warn-icon" aria-hidden="true">⏸</span>
      <div>
        <h2 id="ptx-title">Transação aberta</h2>
        {#if triggerLabel}
          <div class="trigger-label">{triggerLabel}</div>
        {/if}
      </div>
    </div>

    <p id="ptx-desc" class="message">
      {connections.length === 1
        ? "Existe uma transação aberta. Decida o que fazer antes de continuar."
        : `Existem ${connections.length} conexões com transações abertas. Decida cada uma.`}
    </p>

    <ul class="rows">
      {#each connections as row (row.connectionId)}
        {@const dec = perRow[row.connectionId]}
        <li class="row {envClass(row.env)}" data-testid="row-{row.connectionId}">
          <div class="row-head">
            <span class="env-chip" data-env={row.env}>{row.env.toUpperCase()}</span>
            <span class="conn-name">{row.connectionName}</span>
            <span class="count">
              {row.pendingStatements} stmt{row.pendingStatements === 1 ? "" : "s"}
            </span>
            {#if row.lastModifyingType}
              <span class="kind">{row.lastModifyingType.toUpperCase()}</span>
            {/if}
          </div>

          <div class="row-actions">
            <button
              type="button"
              class="ghost"
              class:selected={dec?.kind === "commit"}
              onclick={() => pickRow(row.connectionId, { kind: "commit" })}
              data-testid="commit-{row.connectionId}"
            >
              Commit
            </button>
            <button
              type="button"
              class="danger-ghost"
              class:selected={dec?.kind === "rollback"}
              onclick={() => pickRow(row.connectionId, { kind: "rollback" })}
              data-testid="rollback-{row.connectionId}"
            >
              Rollback
            </button>

            {#if row.env === "prod"}
              <div class="keep-open" data-testid="keep-open-{row.connectionId}">
                <label class="keep-open-label">
                  Manter aberto
                  <select
                    bind:value={keepOpenMinutes[row.connectionId]}
                    aria-label="Janela de keep-open"
                  >
                    <option value={30}>30 min</option>
                    <option value={60}>1 h</option>
                    <option value={120}>2 h</option>
                    <option value={240}>4 h</option>
                    <option value={480}>8 h</option>
                  </select>
                </label>
                <button
                  type="button"
                  class="ghost"
                  class:selected={dec?.kind === "keep_open"}
                  onclick={() =>
                    pickRow(row.connectionId, {
                      kind: "keep_open",
                      minutes: keepOpenMinutes[row.connectionId],
                    })}
                  data-testid="keep-open-apply-{row.connectionId}"
                >
                  Manter
                </button>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <div class="bulk">
      <button
        type="button"
        class="ghost"
        onclick={commitAll}
        disabled={hasStagingOrProd}
        title={hasStagingOrProd ? "Bloqueado: há staging/prod na lista" : ""}
        data-testid="commit-all"
      >
        Commit all
      </button>
      <button
        type="button"
        class="danger-ghost"
        onclick={rollbackAll}
        data-testid="rollback-all"
      >
        Rollback all
      </button>
    </div>

    <p class="hint">
      Esta janela só fecha por decisão explícita. ESC e clicar fora não dispensam.
    </p>

    <div class="actions">
      <button type="button" class="ghost" onclick={onCancel} data-testid="cancel">
        Cancelar
      </button>
      <button
        type="button"
        class="primary"
        onclick={applyDecisions}
        disabled={!allDecided}
        data-testid="apply"
      >
        Aplicar
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.65);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem;
  }
  .modal {
    background: var(--bg-surface); color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: 8px; padding: 1.25rem;
    max-width: 640px; width: 100%;
    display: flex; flex-direction: column; gap: 0.85rem;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    font-family: "Inter", -apple-system, system-ui, sans-serif;
  }
  .head { display: flex; align-items: center; gap: 0.7rem; }
  .warn-icon {
    font-size: 22px; color: #d99c2a;
    background: rgba(217, 153, 42, 0.18);
    width: 32px; height: 32px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  h2 {
    font-family: "Space Grotesk", sans-serif;
    font-size: 18px; font-weight: 600; margin: 0;
  }
  .trigger-label {
    font-size: 11px; color: var(--text-muted);
    font-family: "JetBrains Mono", monospace;
    margin-top: 2px;
  }
  .message { margin: 0; font-size: 13px; color: var(--text-secondary); }
  .rows {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 0.5rem;
    max-height: 280px; overflow-y: auto;
  }
  .row {
    border: 1px solid var(--border);
    border-radius: 6px; padding: 0.55rem 0.7rem;
    background: var(--bg-surface-alt);
    display: flex; flex-direction: column; gap: 0.45rem;
  }
  .row.env-prod {
    border-color: #ff5252;
    box-shadow: 0 0 0 1px rgba(255, 82, 82, 0.25);
  }
  .row.env-staging { border-color: #ff9933; }
  .row-head { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
  .env-chip {
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5px; font-weight: 700;
    padding: 2px 7px; border-radius: 3px;
    letter-spacing: 0.05em;
  }
  .env-chip[data-env="local"] { background: #555; color: #ddd; }
  .env-chip[data-env="dev"] { background: #e8c547; color: #2a2202; }
  .env-chip[data-env="staging"] { background: #ff9933; color: #2a1602; }
  .env-chip[data-env="prod"] { background: #ff5252; color: #fff; }
  .conn-name { font-weight: 600; font-size: 13.5px; }
  .count, .kind {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: var(--text-muted);
  }
  .row-actions {
    display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
  }
  .keep-open {
    display: flex; align-items: center; gap: 0.4rem;
    margin-left: auto;
  }
  .keep-open-label {
    font-size: 11.5px; color: var(--text-muted);
    display: flex; align-items: center; gap: 0.3rem;
  }
  .keep-open-label select {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11.5px;
  }
  .bulk {
    display: flex; gap: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px dashed var(--border);
  }
  .hint { margin: 0; font-size: 11.5px; color: var(--text-muted); }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  button {
    font-family: "Space Grotesk", sans-serif; font-size: 12.5px;
    padding: 0.45rem 0.85rem; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--border-strong);
    background: transparent; color: var(--text-primary);
  }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .ghost.selected { background: var(--row-hover); }
  .ghost:hover:not(:disabled) { background: var(--row-hover); }
  .danger-ghost {
    color: #ff7a5c; border-color: #b33e1f;
  }
  .danger-ghost.selected { background: rgba(179, 62, 31, 0.25); }
  .danger-ghost:hover:not(:disabled) { background: rgba(179, 62, 31, 0.18); }
  .primary {
    background: var(--accent, #2c84ff); color: #fff;
    border-color: var(--accent, #2c84ff); font-weight: 600;
  }
  .primary:hover:not(:disabled) { filter: brightness(1.1); }
</style>
