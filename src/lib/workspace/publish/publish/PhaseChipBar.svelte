<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  const phases = ["build", "encrypt", "upload", "grant", "done"] as const;
  type Phase = (typeof phases)[number];

  function statusOf(phase: Phase): "idle" | "active" | "ok" | "error" {
    const order = phases.indexOf(phase);
    const cur = phases.indexOf(wizard.state.publish.phase as Phase);
    if (wizard.state.publish.phase === "error") {
      return order < cur ? "ok" : order === cur ? "error" : "idle";
    }
    if (wizard.state.publish.phase === "idle") return "idle";
    if (cur === -1) return "idle";
    if (order < cur) return "ok";
    if (order === cur) return "active";
    return "idle";
  }

  function label(phase: Phase): string {
    return phase[0].toUpperCase() + phase.slice(1);
  }

  function symbol(s: string): string {
    if (s === "ok") return "✓";
    if (s === "active") return "⏳";
    if (s === "error") return "✗";
    return "·";
  }
</script>

{#snippet srHint(s: ReturnType<typeof statusOf>)}
  {#if s === "active"} (in progress){/if}
  {#if s === "ok"} (completed){/if}
  {#if s === "error"} (failed){/if}
{/snippet}

<ol class="bar" aria-label="Publish phases">
  {#each phases as p (p)}
    {@const s = statusOf(p)}
    <li
      class="chip"
      data-status={s}
      aria-current={s === "active" ? "step" : undefined}
    >
      <span class="sym" aria-hidden="true">{symbol(s)}</span>
      {label(p)}
      <span class="sr-only">{@render srHint(s)}</span>
    </li>
  {/each}
</ol>

<style>
  .bar {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
    list-style: none;
    padding: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .chip {
    flex: 1;
    padding: 6px 8px;
    border-radius: 4px;
    text-align: center;
    font-size: 12px;
    background: var(--bg-surface-alt);
    color: var(--text-muted);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }
  .sym { font-size: 11px; }
  .chip[data-status="active"] {
    background: var(--accent, #3b82f6);
    color: white;
    border-color: transparent;
  }
  .chip[data-status="ok"] {
    background: #10b981;
    color: white;
    border-color: transparent;
  }
  .chip[data-status="error"] {
    background: #ef4444;
    color: white;
    border-color: transparent;
  }
</style>
