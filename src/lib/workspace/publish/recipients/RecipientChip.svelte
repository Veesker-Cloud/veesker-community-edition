<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  let {
    email,
    userId,
    pubkeyOk,
    onRemove,
  }: {
    email: string;
    userId: string | null;
    pubkeyOk: boolean;
    onRemove: () => void;
  } = $props();
</script>

<div class="chip" class:ok={pubkeyOk} class:warn={!pubkeyOk}>
  <span class="email">{email}</span>
  {#if userId}
    <span class="muted" title={userId}>· {userId.slice(0, 8)}…</span>
  {/if}
  {#if pubkeyOk}
    <span class="tick" aria-label="recipient ready">✓</span>
  {:else}
    <span class="tag" title="User not yet onboarded — they need to install Veesker and register a keypair">
      not onboarded
    </span>
  {/if}
  <button
    type="button"
    onclick={onRemove}
    aria-label={`Remove ${email}`}
  >×</button>
</div>

<style>
  .chip {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  .chip.warn {
    background: rgba(245, 158, 11, 0.12);
    border-color: rgba(245, 158, 11, 0.4);
  }
  .email { font-weight: 500; }
  .muted { color: var(--text-muted); font-size: 10px; font-family: monospace; }
  .tick { color: #10b981; font-weight: bold; }
  .tag {
    font-size: 9px;
    background: #f59e0b;
    color: white;
    padding: 1px 6px;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  button {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--text-muted);
    margin-left: auto;
    padding: 0 4px;
    font: inherit;
  }
  button:hover { color: var(--text-primary); }
</style>
