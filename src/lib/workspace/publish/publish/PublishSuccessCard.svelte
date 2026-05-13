<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  const failed = $derived.by<string[]>(() => {
    const out: string[] = [];
    for (const [user, r] of wizard.state.publish.grantResults.entries()) {
      if (r !== "ok") out.push(user);
    }
    return out;
  });
</script>

<div class="card">
  <div class="emoji" aria-hidden="true">🎉</div>
  <h2>Sandbox published</h2>
  <p><strong>{wizard.state.spec.sandboxName}</strong></p>
  {#if wizard.state.publish.sandboxId}
    <p class="muted">ID: <code>{wizard.state.publish.sandboxId}</code></p>
  {/if}
  {#if failed.length > 0}
    <p class="warn">⚠ {failed.length} grant(s) failed — re-grant from sandbox detail page.</p>
  {/if}
  <div class="row">
    {#if wizard.state.publish.sandboxId}
      <button
        type="button"
        class="btn-primary"
        onclick={() => void goto(`/sandboxes/${wizard.state.publish.sandboxId}`)}
      >View sandbox →</button>
    {/if}
    <button type="button" class="btn-secondary" onclick={() => wizard.reset()}>
      Publish another
    </button>
  </div>
</div>

<style>
  .card {
    text-align: center;
    max-width: 500px;
    margin: 60px auto;
    padding: 32px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .emoji { font-size: 48px; }
  h2 { margin: 8px 0 4px 0; }
  .muted { color: var(--text-muted); }
  .warn { color: var(--warn-text, #fbbf24); }
  code { font-family: monospace; }
  .row {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 16px;
  }
  .btn-primary, .btn-secondary {
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  .btn-primary {
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
  }
  .btn-secondary {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
</style>
