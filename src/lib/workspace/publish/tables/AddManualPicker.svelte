<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  let open = $state(false);
  let query = $state("");

  const matches = $derived.by<string[]>(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    const eff = new Set(wizard.effectiveTables().map((t) => t.name));
    return wizard.state.tables.available
      .map((t) => t.name)
      .filter((n) => n.toLowerCase().includes(q) && !eff.has(n))
      .slice(0, 8);
  });

  function add(name: string) {
    wizard.addManual(name);
    query = "";
    open = false;
  }
</script>

{#if !open}
  <button type="button" class="btn" onclick={() => (open = true)}>+ Add manual</button>
{:else}
  <div class="picker">
    <input
      placeholder="Search to add a lookup table..."
      bind:value={query}
    />
    {#if matches.length > 0}
      <ul>
        {#each matches as name (name)}
          <li>
            <button type="button" onclick={() => add(name)}>{name}</button>
          </li>
        {/each}
      </ul>
    {:else if query.trim() !== ""}
      <p class="empty">No untaken table matches.</p>
    {/if}
    <button
      type="button"
      class="cancel"
      onclick={() => {
        open = false;
        query = "";
      }}
    >Cancel</button>
  </div>
{/if}

<style>
  .btn {
    padding: 6px 12px;
    background: var(--bg-surface-alt);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 280px;
    padding: 8px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--accent, #3b82f6);
    border-radius: 4px;
  }
  .picker input {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-page);
    color: var(--text-primary);
    font: inherit;
  }
  .picker ul { list-style: none; padding: 0; margin: 0; }
  .picker li button {
    width: 100%;
    text-align: left;
    padding: 4px 8px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-primary);
    font: inherit;
  }
  .picker li button:hover { background: var(--bg-surface-alt); }
  .empty { color: var(--text-muted); font-size: 11px; margin: 0; padding: 4px 8px; }
  .cancel {
    padding: 4px 8px;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
    align-self: flex-end;
    font-family: inherit;
  }
</style>
