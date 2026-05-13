<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  const counts = $derived.by(() => {
    const eff = wizard.effectiveTables();
    const explicit = eff.filter((t) => t.origin === "explicit").length;
    const manual = eff.filter((t) => t.origin === "manual").length;
    const byDepth = new Map<number, number>();
    for (const t of eff.filter((x) => x.origin === "fk")) {
      byDepth.set(t.depth, (byDepth.get(t.depth) ?? 0) + 1);
    }
    return { explicit, manual, fkByDepth: byDepth, total: eff.length };
  });

  const fkByDepthSorted = $derived(
    [...counts.fkByDepth.entries()].sort((a, b) => a[0] - b[0]),
  );
  const e2eOk = $derived(!wizard.hasE2eExclusionWarning());
</script>

<div class="pane">
  <header><strong>Summary</strong></header>
  <dl>
    <dt>Source</dt><dd>{wizard.state.source.schemaName ?? "—"}</dd>
    <dt>Explicit</dt><dd>{counts.explicit}</dd>
    {#each fkByDepthSorted as [d, n] (d)}
      <dt>Via FK ({d}-hop)</dt><dd>{n}</dd>
    {/each}
    <dt>Manual</dt><dd>{counts.manual}</dd>
    <dt class="total">Total</dt><dd class="total">{counts.total}</dd>
  </dl>
  <p class="status" class:ok={e2eOk} class:warn={!e2eOk}>
    {e2eOk ? "✓ Referential integrity preserved" : "⚠ Referential integrity warning"}
  </p>
</div>

<style>
  .pane {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
    background: var(--bg-surface-alt);
    color: var(--text-primary);
    min-height: 400px;
    max-height: 480px;
    overflow-y: auto;
  }
  header {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 12px;
    font-size: 12px;
  }
  dt { color: var(--text-muted); }
  dd { margin: 0; text-align: right; }
  dt.total, dd.total {
    font-weight: bold;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .status {
    margin-top: 16px;
    padding: 8px;
    border-radius: 4px;
    font-size: 12px;
  }
  .status.ok { background: rgba(16,185,129,0.1); color: #10b981; }
  .status.warn { background: rgba(245,158,11,0.1); color: var(--warn-text, #fbbf24); }
</style>
