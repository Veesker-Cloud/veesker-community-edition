<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import RecipientInput from "./recipients/RecipientInput.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  const expiresAt = $derived.by(() => {
    const d = new Date();
    d.setDate(d.getDate() + wizard.state.spec.ttlDays);
    return d.toISOString().slice(0, 10);
  });

  function setTtl(n: number) {
    if (!Number.isFinite(n)) return;
    wizard.setSpec({ ttlDays: n });
  }
  function setPii(level: 0 | 1 | 2) {
    wizard.setSpec({ piiLevel: level });
  }
  function dayLabel(n: number): string {
    return `${n} day${n === 1 ? "" : "s"}`;
  }
</script>

<div class="grid">
  <div class="left">
    <label class="block">
      <span class="lbl">Sandbox name</span>
      <input
        type="text"
        value={wizard.state.spec.sandboxName}
        oninput={(e) => wizard.setSpec({ sandboxName: (e.currentTarget as HTMLInputElement).value })}
        placeholder="ORDERS_2025_DEMO"
      />
    </label>

    <div class="block">
      <span class="lbl">TTL · expires after</span>
      <div class="row">
        <button
          type="button"
          class:active={wizard.state.spec.ttlDays === 7}
          onclick={() => setTtl(7)}
        >7 days</button>
        <button
          type="button"
          class:active={wizard.state.spec.ttlDays === 30}
          onclick={() => setTtl(30)}
        >30 days</button>
        <button
          type="button"
          class:active={wizard.state.spec.ttlDays === 90}
          onclick={() => setTtl(90)}
        >90 days</button>
        <span class="muted">or</span>
        <input
          type="number"
          min="1"
          max="90"
          value={wizard.state.spec.ttlDays}
          oninput={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const raw = el.valueAsNumber;
            if (!Number.isFinite(raw)) return;
            setTtl(raw);
            // setSpec clamps to [1, 90]; reflect the clamped value back into
            // the DOM so the input doesn't diverge from state when the user
            // types out-of-range numbers like 999 or -5.
            const clamped = wizard.state.spec.ttlDays;
            if (el.valueAsNumber !== clamped) el.value = String(clamped);
          }}
          aria-label="Custom TTL days"
          class="num"
        />
        <span>{wizard.state.spec.ttlDays === 1 ? "day" : "days"}</span>
      </div>
      <small class="muted">{dayLabel(wizard.state.spec.ttlDays)} — will expire on <strong>{expiresAt}</strong>.</small>
    </div>

    <div class="block">
      <span class="lbl">PII detection</span>
      {#each [0, 1, 2] as lvl (lvl)}
        <label class="radio-card" class:active={wizard.state.spec.piiLevel === lvl}>
          <input
            type="radio"
            name="pii"
            checked={wizard.state.spec.piiLevel === lvl}
            onchange={() => setPii(lvl as 0 | 1 | 2)}
          />
          <div>
            <strong>
              Level {lvl} —
              {#if lvl === 0}Off
              {:else if lvl === 1}Column name only
              {:else}Name + sample values{/if}
            </strong>
            {#if lvl === 2}<span class="tag">recommended</span>{/if}
            <p class="muted">
              {#if lvl === 0}No detection. Nothing masked.
              {:else if lvl === 1}Detects EMAIL, CPF, PHONE by column name. Fast.
              {:else}Samples 100 rows per column. Catches cryptic columns.
              {/if}
            </p>
          </div>
        </label>
      {/each}
      <small class="muted">You'll review and override masks in Step 4.</small>
    </div>
  </div>

  <aside class="right">
    <header>Recipients (optional)</header>
    <small class="muted">Members get a copy encrypted to their pubkey.</small>
    <RecipientInput {wizard} />
  </aside>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1.5fr 1fr;
    gap: 24px;
    max-width: 900px;
  }
  .lbl { font-weight: bold; display: block; margin-bottom: 4px; }
  .block { margin-bottom: 18px; }
  .block input[type="text"], .block input[type="number"] {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-page);
    color: var(--text-primary);
    font: inherit;
  }
  .block input.num { width: 64px; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .row button {
    padding: 6px 12px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  .row button.active {
    background: var(--accent, #3b82f6);
    color: white;
    border-color: transparent;
  }
  .radio-card {
    display: flex;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    margin-bottom: 6px;
    cursor: pointer;
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .radio-card.active {
    border-color: var(--accent, #3b82f6);
    background: var(--bg-surface-alt);
  }
  .radio-card:focus-within {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: 2px;
  }
  .radio-card .muted { font-size: 11px; margin: 4px 0 0 0; }
  .tag {
    font-size: 9px;
    background: var(--accent, #3b82f6);
    color: white;
    padding: 1px 6px;
    border-radius: 8px;
    margin-left: 6px;
  }
  .right {
    background: var(--bg-surface-alt);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
  }
  .right header {
    font-weight: bold;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .muted { color: var(--text-muted); font-size: 12px; }
</style>
