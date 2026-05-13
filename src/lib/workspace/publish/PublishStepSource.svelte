<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import {
    listConnections,
    sandboxOracleCheck,
    type ConnectionMeta,
  } from "$lib/connections";

  let { wizard }: { wizard: PublishWizard } = $props();

  let connections = $state<ConnectionMeta[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let checking = $state<string | null>(null);

  async function refresh() {
    loading = true;
    const res = await listConnections();
    if (res.ok) {
      connections = res.data;
      error = null;
    } else {
      error = res.error.message;
    }
    loading = false;
  }

  onMount(refresh);

  function describe(c: ConnectionMeta): string {
    if (c.authType === "basic") {
      return `${c.host}:${c.port}/${c.serviceName}`;
    }
    return `wallet · ${c.connectAlias}`;
  }

  async function pick(c: ConnectionMeta) {
    error = null;
    checking = c.id;
    wizard.setSource(c.id, c.username, false);
    const ok = await sandboxOracleCheck(c.id);
    if (checking !== c.id) return;
    checking = null;
    if (ok.ok) {
      wizard.setCredsReady(true);
    } else {
      wizard.setCredsReady(false);
      error = ok.error.message;
    }
  }
</script>

<div class="step">
  <h2>Choose source connection</h2>

  {#if loading}
    <p class="muted">Loading connections...</p>
  {:else if error}
    <p class="error">Failed to load connections: {error}</p>
    <button class="btn-secondary" onclick={refresh}>Retry</button>
  {:else if connections.length === 0}
    <div class="empty">
      <p>You need an Oracle connection first.</p>
      <button class="btn-primary" onclick={() => void goto("/connections/new")}>+ Add your first connection</button>
    </div>
  {:else}
    <ul class="conn-list">
      {#each connections as c (c.id)}
        <li>
          <button
            type="button"
            class="conn-row"
            class:selected={wizard.state.source.connectionId === c.id}
            onclick={() => void pick(c)}
            disabled={checking !== null}
          >
            <strong>{c.name}</strong>
            <span class="muted">
              {describe(c)} · {c.username}
              {#if checking === c.id} · checking credentials…{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
    <button class="btn-link" onclick={() => void goto("/connections/new")}>+ Add another connection</button>
  {/if}
</div>

<style>
  .step {
    max-width: 800px;
    margin: 0 auto;
    width: 100%;
  }
  h2 { margin: 0 0 16px 0; }
  .empty { padding: 40px; text-align: center; border: 1px dashed var(--border); border-radius: 6px; }
  .conn-list { list-style: none; padding: 0; margin: 0; }
  .conn-list li { margin-bottom: 8px; }
  .conn-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    width: 100%;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    background: var(--bg-surface);
    color: var(--text-primary);
    text-align: left;
    font: inherit;
  }
  .conn-row:hover { background: var(--bg-surface-alt); }
  .conn-row.selected { border-color: var(--accent, #3b82f6); }
  .muted { color: var(--text-muted); font-size: 12px; }
  .error { color: #ef4444; }
  .btn-primary, .btn-secondary {
    padding: 8px 16px;
    border-radius: 4px;
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .btn-primary { background: var(--accent, #3b82f6); color: white; border: none; }
  .btn-secondary { background: var(--bg-surface); color: var(--text-primary); }
  .btn-link {
    background: none; border: none; color: var(--accent, #3b82f6);
    cursor: pointer; padding: 8px 0;
  }
</style>
