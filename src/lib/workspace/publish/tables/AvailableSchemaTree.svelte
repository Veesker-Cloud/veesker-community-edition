<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import { listSchemaTables, type SchemaTableInfo } from "$lib/sandbox";

  let { wizard }: { wizard: PublishWizard } = $props();

  let loading = $state(false);
  let error = $state<string | null>(null);
  let search = $state("");

  let lastKey = "";

  $effect(() => {
    const conn = wizard.state.source.connectionId;
    const schema = wizard.state.source.schemaName;
    if (!conn || !schema) return;
    const key = `${conn}|${schema}`;
    // Refetch when the source key changes OR when the cached `available` was
    // wiped (e.g. wizard.setSource() schema-change reset cleared the cache
    // even though the user may toggle back to the same source). Without the
    // empty-cache guard a back→same-source flow would be stuck on an empty
    // list because the lastKey check would short-circuit.
    if (key === lastKey && wizard.state.tables.available.length > 0) return;
    lastKey = key;
    loading = true;
    error = null;
    listSchemaTables(conn, schema)
      .then((r) => {
        wizard.setAvailableTables(r.tables);
        loading = false;
      })
      .catch((e) => {
        error = String(e?.message ?? e);
        loading = false;
      });
  });

  const filtered = $derived.by<SchemaTableInfo[]>(() => {
    const q = search.trim().toLowerCase();
    const all = wizard.state.tables.available;
    if (q === "") return all;
    return all.filter((t) => t.name.toLowerCase().includes(q));
  });

  function isChecked(name: string): boolean {
    return wizard.state.tables.explicit.some((t) => t.name === name.toUpperCase());
  }

  function toggle(name: string) {
    if (isChecked(name)) wizard.removeExplicitTable(name);
    else wizard.addExplicitTable(name);
  }
</script>

<div class="pane">
  <header><strong>Available</strong></header>
  <input
    class="search"
    placeholder="Search tables..."
    bind:value={search}
  />
  {#if loading}
    <p class="muted">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if filtered.length === 0}
    <p class="muted">No tables match.</p>
  {:else}
    <ul class="tree">
      {#each filtered as t (t.name)}
        <li>
          <label>
            <input
              type="checkbox"
              checked={isChecked(t.name)}
              onchange={() => toggle(t.name)}
              aria-label={t.name}
            />
            <span class="name">{t.name}</span>
            {#if t.rowCount !== null}
              <span class="muted">· {t.rowCount.toLocaleString()} rows</span>
            {/if}
          </label>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .pane {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    min-height: 400px;
    max-height: 480px;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  header {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .search {
    width: 100%;
    padding: 6px 8px;
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-page);
    color: var(--text-primary);
    font: inherit;
  }
  .tree {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
  }
  .tree li { padding: 2px 0; min-width: 0; }
  .tree label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
    font-size: 13px;
    min-width: 0;
  }
  .tree .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tree .muted {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .name { font-weight: 500; }
  .muted { color: var(--text-muted); font-size: 11px; }
  .error { color: #ef4444; font-size: 12px; }
</style>
