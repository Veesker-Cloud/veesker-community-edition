<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  let { wizard }: { wizard: PublishWizard } = $props();

  let logEl: HTMLDivElement | undefined = $state();
  // Sticky-bottom autoscroll: follow new lines when the user is at (or near)
  // the bottom; release follow when they scroll up to read history. The
  // "↓ Jump to latest" pill re-engages it in one click.
  let autoFollow = $state(true);

  function onScroll() {
    if (!logEl) return;
    const distFromBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
    autoFollow = distFromBottom < 12;
  }

  function jumpToLatest() {
    if (!logEl) return;
    logEl.scrollTop = logEl.scrollHeight;
    autoFollow = true;
  }

  $effect(() => {
    // Re-run whenever the line count changes; if autofollow is on, scroll.
    const _ = wizard.state.publish.progressLines.length;
    if (autoFollow && logEl) logEl.scrollTop = logEl.scrollHeight;
  });
</script>

<div class="wrap">
  <div
    class="log"
    role="log"
    aria-live="polite"
    aria-label="Publish progress log"
    bind:this={logEl}
    onscroll={onScroll}
  >
    {#if wizard.state.publish.progressLines.length === 0}
      <div class="log-line muted">(no events yet)</div>
    {:else}
      {#each wizard.state.publish.progressLines as line, i (i)}
        <div class="log-line">{line}</div>
      {/each}
    {/if}
  </div>
  {#if !autoFollow && wizard.state.publish.progressLines.length > 0}
    <button type="button" class="jump" onclick={jumpToLatest}>↓ Jump to latest</button>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .log {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    max-height: 180px;
    overflow-y: auto;
    background: var(--bg-page);
    color: var(--text-primary);
    font-family: monospace;
    font-size: 11px;
  }
  .log-line { padding: 1px 0; }
  .muted { color: var(--text-muted); }
  .jump {
    position: absolute;
    right: 12px;
    bottom: 12px;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    font: inherit;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  }
</style>
