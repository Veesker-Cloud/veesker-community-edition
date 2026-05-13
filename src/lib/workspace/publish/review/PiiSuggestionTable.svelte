<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import PiiMaskSelect from "./PiiMaskSelect.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  function maskFor(t: string, c: string, suggested: string): string {
    return wizard.state.review.piiOverrides.get(`${t.toUpperCase()}.${c.toUpperCase()}`) ?? suggested;
  }

  function confColor(c: number): string {
    if (c >= 0.9) return "var(--success-text, #34d399)";
    if (c >= 0.6) return "var(--warn-text, #fbbf24)";
    return "var(--error-text, #f87171)";
  }
</script>

{#if wizard.state.review.piiSuggestions.length === 0}
  <p class="empty">No PII columns detected.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Column</th>
        <th>Detected</th>
        <th>Mask</th>
        <th class="r">Conf.</th>
      </tr>
    </thead>
    <tbody>
      {#each wizard.state.review.piiSuggestions as s (`${s.table}.${s.column}`)}
        <tr>
          <td><code>{s.table}.{s.column}</code></td>
          <td>{s.category}</td>
          <td>
            <PiiMaskSelect
              value={maskFor(s.table, s.column, s.suggestedMask)}
              suggested={s.suggestedMask}
              onChange={(v) => wizard.setPiiOverride(s.table, s.column, v)}
            />
          </td>
          <td class="r" style="color: {confColor(s.confidence)};">{s.confidence.toFixed(2)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th {
    text-align: left;
    padding: 4px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-weight: normal;
  }
  tbody td { padding: 4px; border-bottom: 1px solid var(--border); color: var(--text-primary); }
  .r { text-align: right; }
  code { font-family: monospace; }
  .empty { color: var(--text-muted); font-size: 12px; }
</style>
