<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import {
    buildSandboxDryRun,
    type DryRunDoneEvent,
    type SchemaTableInfo,
  } from "$lib/sandbox";
  import E2eWarningBanner from "./review/E2eWarningBanner.svelte";
  import PiiSuggestionTable from "./review/PiiSuggestionTable.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  function sumSizeForClosure(
    available: SchemaTableInfo[],
    closureNames: string[],
  ): { rows: number; bytes: number } {
    const want = new Set(closureNames.map((n) => n.toUpperCase()));
    let rows = 0;
    let bytes = 0;
    for (const t of available) {
      if (!want.has(t.name.toUpperCase())) continue;
      if (t.rowCount !== null) rows += t.rowCount;
      if (t.sizeBytesEst !== null) bytes += t.sizeBytesEst;
    }
    return { rows, bytes };
  }

  // Drop late dryRun results when the user has navigated away or fired a fresh
  // dryRun in between — without this guard a back→edit→forward race would
  // overwrite fresh PII suggestions with stale ones from a prior call (and
  // canAdvance would let the user publish against a misleading review).
  let dryRunToken = 0;

  async function runDryRun() {
    const conn = wizard.state.source.connectionId;
    const schema = wizard.state.source.schemaName;
    if (!conn || !schema) {
      wizard.setDryRunStatus("error", "missing connection");
      return;
    }
    const myToken = ++dryRunToken;
    wizard.setDryRunStatus("running");
    try {
      const resp = await buildSandboxDryRun({
        connectionId: conn,
        schemaName: schema,
        sandboxName: wizard.state.spec.sandboxName,
        ttlDays: wizard.state.spec.ttlDays,
        piiLevel: wizard.state.spec.piiLevel,
        primaryTables: wizard.state.tables.explicit,
        fkWalkDepth: wizard.state.tables.fkDepth,
      });
      if (myToken !== dryRunToken) return;
      const dryDone = resp.events.find(
        (e): e is DryRunDoneEvent => e.phase === "dry-run-done",
      );
      const errEvt = resp.events.find((e) => e.phase === "error");
      if (errEvt && "message" in errEvt) {
        wizard.setDryRunStatus("error", String(errEvt.message));
        return;
      }
      if (!dryDone) {
        wizard.setDryRunStatus("error", "sidecar returned no dry-run-done event");
        return;
      }
      wizard.state.review.piiSuggestions = dryDone.piiSuggestions;
      const { rows, bytes } = sumSizeForClosure(
        wizard.state.tables.available,
        dryDone.fkClosureTables,
      );
      wizard.state.review.estimatedSizeBytes = bytes;
      wizard.state.review.estimatedTotalRows = rows;
      wizard.setDryRunStatus("ok");
    } catch (err) {
      if (myToken !== dryRunToken) return;
      wizard.setDryRunStatus(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  $effect(() => {
    if (wizard.state.currentStep !== 4) return;
    if (wizard.state.review.dryRunStatus !== "idle") return;
    void runDryRun();
  });

  function fmtBytes(n: number): string {
    if (n === 0) return "—";
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }
</script>

{#if wizard.hasE2eExclusionWarning()}
  <E2eWarningBanner onBack={() => wizard.back()} />
{/if}

<div class="grid">
  <div class="left">
    <section class="card">
      <header>Spec summary</header>
      <dl>
        <dt>Source</dt><dd>{wizard.state.source.schemaName ?? "—"}</dd>
        <dt>Name</dt><dd><strong>{wizard.state.spec.sandboxName || "(unnamed)"}</strong></dd>
        <dt>TTL</dt><dd>{wizard.state.spec.ttlDays} days</dd>
        <dt>PII level</dt><dd>{wizard.state.spec.piiLevel}</dd>
        <dt>FK depth</dt><dd>{wizard.state.tables.fkDepth}</dd>
      </dl>
    </section>

    <section class="card">
      <header>Final tables · {wizard.effectiveTables().length}</header>
      <ul class="tlist">
        {#each wizard.effectiveTables() as t (t.name)}
          <li>
            <span class="prefix">{t.origin === "explicit" ? "★" : t.origin === "fk" ? "↳" : "+"}</span>
            {t.name}
          </li>
        {/each}
      </ul>
      {#if wizard.state.tables.available.length === 0}
        <p class="muted">Size estimate unavailable (Step 2 didn't load any table stats).</p>
      {:else if wizard.state.review.estimatedSizeBytes === 0 && wizard.state.review.estimatedTotalRows === 0}
        <p class="muted">No rows estimated — schema stats may be stale or USER_SEGMENTS unreadable.</p>
      {:else}
        <p class="muted">
          ~ {fmtBytes(wizard.state.review.estimatedSizeBytes)} ·
          {wizard.state.review.estimatedTotalRows.toLocaleString()} rows
        </p>
      {/if}
    </section>

    <section class="card">
      <header>Recipients · {wizard.state.spec.recipients.length}</header>
      {#if wizard.state.spec.recipients.length === 0}
        <p class="muted">No recipients (you'll keep the only copy).</p>
      {:else}
        <ul>
          {#each wizard.state.spec.recipients as r (r.email)}
            <li>{r.email} {r.pubkeyOk ? "✓" : "(not onboarded)"}</li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <div class="right">
    <div class="head">
      <h3>PII suggestions · {wizard.state.review.piiSuggestions.length}</h3>
      {#if wizard.state.review.dryRunStatus === "ok" || wizard.state.review.dryRunStatus === "error"}
        <button type="button" class="rescan" onclick={() => void runDryRun()}>Re-scan</button>
      {/if}
    </div>
    {#if wizard.state.review.dryRunStatus === "running"}
      <p class="muted">Scanning columns for PII…</p>
    {:else if wizard.state.review.dryRunStatus === "error"}
      <p class="error">Pre-scan failed: {wizard.state.review.dryRunError}</p>
    {:else}
      <PiiSuggestionTable {wizard} />
    {/if}
  </div>
</div>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 16px; }
  .grid > :global(*) { min-width: 0; }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 10px;
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .card header {
    font-weight: bold;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 6px;
    font-size: 13px;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    font-size: 12px;
  }
  dt { color: var(--text-muted); }
  dd { margin: 0; }
  .tlist {
    list-style: none;
    padding: 0;
    max-height: 160px;
    overflow-y: auto;
    font-size: 12px;
  }
  .tlist li { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
  .prefix { font-weight: bold; min-width: 14px; }
  .muted { color: var(--text-muted); font-size: 12px; margin: 0; }
  .error { color: #ef4444; font-size: 12px; }
  h3 { margin: 0; font-size: 13px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .rescan {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 11px;
    font: inherit;
  }
  .rescan:hover { color: var(--text-primary); }
</style>
