<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import TableFilterPopover from "./TableFilterPopover.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  let popoverFor = $state<string | null>(null);

  const rows = $derived(wizard.effectiveTables());

  // Excluded FK rows used to vanish from the picker — the user had no way to
  // re-include without removing/re-adding the parent. Surface them here as a
  // collapsible footer with an Include action so the workflow is reversible.
  const excludedFkRows = $derived.by(() => {
    const out: { name: string; depth: number }[] = [];
    for (const e of wizard.state.tables.fkClosure) {
      if (e.depth === 0) continue;
      if (!wizard.state.tables.excluded.has(e.name)) continue;
      out.push({ name: e.name, depth: e.depth });
    }
    return out;
  });
  let showExcluded = $state(false);

  function tableSpec(name: string) {
    return wizard.state.tables.explicit.find((t) => t.name === name);
  }
</script>

<div class="pane">
  <header>
    <strong>Going to sandbox</strong>
    <span class="count">{rows.length}</span>
  </header>

  {#if rows.length === 0}
    <p class="empty">Pick a table on the left to start.</p>
  {:else}
    <ul>
      {#each rows as t (t.name)}
        <li class="row" class:fk={t.origin === "fk"} class:manual={t.origin === "manual"}>
          {#if t.origin === "explicit"}
            <span class="prefix">★</span>
            <strong class="name">{t.name}</strong>
            <span class="badge explicit">explicit</span>
            <button
              type="button"
              class="cog"
              aria-label={`Filter rows for ${t.name}`}
              title="Filter rows"
              onclick={() => (popoverFor = popoverFor === t.name ? null : t.name)}
            >⚙</button>
            <button
              type="button"
              class="x"
              aria-label={`Remove ${t.name}`}
              title="Remove"
              onclick={() => wizard.removeExplicitTable(t.name)}
            >×</button>
            {#if tableSpec(t.name)?.whereClause}
              <span class="filter-tag">WHERE {tableSpec(t.name)?.whereClause}</span>
            {/if}
          {:else if t.origin === "fk"}
            <span class="prefix indent">↳</span>
            <span class="name">{t.name}</span>
            <span class="badge fk-badge">FK·{t.depth}</span>
            <button
              type="button"
              class="x"
              aria-label={`Exclude ${t.name} (members will lose referential integrity for this table)`}
              title="Exclude — members will lose referential integrity for this table"
              onclick={() => wizard.excludeTable(t.name)}
            >×</button>
          {:else}
            <span class="prefix">+</span>
            <span class="name">{t.name}</span>
            <span class="badge manual-badge">manual</span>
            <button
              type="button"
              class="x"
              aria-label={`Remove manual ${t.name}`}
              title="Remove"
              onclick={() => wizard.removeManual(t.name)}
            >×</button>
          {/if}

          {#if popoverFor === t.name}
            <TableFilterPopover
              tableName={t.name}
              initialWhere={tableSpec(t.name)?.whereClause ?? ""}
              initialRowCap={tableSpec(t.name)?.rowCap ?? null}
              onSave={(w, r) => wizard.setTableFilter(t.name, w, r ?? undefined)}
              onClose={() => (popoverFor = null)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if excludedFkRows.length > 0}
    <details class="excluded" bind:open={showExcluded}>
      <summary>
        <strong>Excluded</strong>
        <span class="count">{excludedFkRows.length}</span>
      </summary>
      <ul>
        {#each excludedFkRows as t (t.name)}
          <li class="row excluded-row">
            <span class="prefix indent">↳</span>
            <s class="name">{t.name}</s>
            <span class="badge fk-badge">FK·{t.depth}</span>
            <button
              type="button"
              class="include"
              aria-label={`Include ${t.name} again`}
              title="Include again"
              onclick={() => wizard.unexcludeTable(t.name)}
            >Include</button>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  .pane {
    border: 1px solid var(--accent, #3b82f6);
    border-radius: 4px;
    padding: 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    min-height: 400px;
    max-height: 480px;
    overflow-y: auto;
    position: relative;
  }
  header {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .count { color: var(--text-muted); font-size: 12px; }
  .empty { color: var(--text-muted); font-size: 13px; padding: 12px 0; }
  ul { list-style: none; padding: 0; margin: 0; }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 4px 0;
    font-size: 13px;
    position: relative;
  }
  .row.fk { opacity: 0.85; }
  .row.manual { font-style: italic; }
  .prefix { font-weight: bold; min-width: 14px; text-align: center; }
  .indent { padding-left: 14px; }
  .name { color: var(--text-primary); }
  .badge {
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 8px;
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge.explicit { background: var(--accent, #3b82f6); }
  .badge.fk-badge { background: #6366f1; }
  .badge.manual-badge { background: #a855f7; }
  .cog, .x {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1;
    padding: 2px 6px;
    min-width: 24px;
    min-height: 24px;
    border-radius: 3px;
    font: inherit;
  }
  .cog:hover {
    color: var(--text-primary);
    background: var(--bg-surface-alt);
  }
  .x:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.3);
  }
  .filter-tag {
    font-size: 10px;
    color: var(--text-muted);
    padding-left: 8px;
    font-family: monospace;
  }
  .excluded {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
  }
  .excluded summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .excluded ul { margin-top: 6px; }
  .excluded-row { opacity: 0.7; }
  .excluded-row .name { color: var(--text-muted); }
  .include {
    margin-left: auto;
    background: transparent;
    color: var(--accent, #3b82f6);
    border: 1px solid var(--accent, #3b82f6);
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 11px;
    font: inherit;
  }
  .include:hover {
    background: var(--accent, #3b82f6);
    color: white;
  }
</style>
