<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import type { OpenSandboxColumn } from "$lib/sandbox";

  type Props = {
    tables: string[];
    columns: OpenSandboxColumn[];
  };
  let { tables, columns }: Props = $props();

  const columnsByTable = $derived.by(() => {
    const m = new Map<string, OpenSandboxColumn[]>();
    for (const c of columns) {
      if (!m.has(c.table_name)) m.set(c.table_name, []);
      m.get(c.table_name)!.push(c);
    }
    return m;
  });

  let expanded = $state<Set<string>>(new Set());

  function toggle(t: string) {
    const next = new Set(expanded);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    expanded = next;
  }
</script>

<aside class="sl">
  <h4>Schema</h4>
  {#each tables as t}
    <div class="tbl">
      <button class="tbl-name" onclick={() => toggle(t)}>
        {expanded.has(t) ? "▾" : "▸"} {t}
      </button>
      {#if expanded.has(t)}
        <ul class="cols">
          {#each columnsByTable.get(t) ?? [] as c}
            <li>
              <span class="cn">{c.name}</span>
              <span class="ct">{c.type}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/each}
</aside>

<style>
  .sl { padding: 12px; background: var(--bg-surface-alt); border-right: 1px solid var(--border); overflow: auto; min-width: 200px; }
  h4 { margin: 0 0 8px; font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
  .tbl-name { background: transparent; border: none; color: var(--text-primary); cursor: pointer; padding: 2px 0; font-size: 12px; text-align: left; }
  .cols { list-style: none; padding: 0 0 0 16px; margin: 4px 0 8px; }
  .cols li { font-size: 11px; color: var(--text-muted); padding: 1px 0; }
  .cn { color: var(--text-primary); }
  .ct { margin-left: 6px; }
</style>
