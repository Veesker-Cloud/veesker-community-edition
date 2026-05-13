<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  let {
    message,
    onRetry,
    onRetryFromUpload,
    onBack,
  }: {
    message: string;
    onRetry: () => void;
    /** Surfaced only when a previous Build succeeded and produced a `.vsk`
     *  the wizard can resume from. Skips the (potentially minutes-long)
     *  Oracle extract + encrypt phase and re-runs only Upload + Grant. */
    onRetryFromUpload?: () => void;
    onBack: () => void;
  } = $props();
</script>

<div class="banner">
  <strong>Publish failed</strong>
  <pre>{message}</pre>
  <div class="row">
    <button type="button" onclick={onBack}>← Back to Tables</button>
    <button type="button" onclick={onRetry}>Retry from Build</button>
    {#if onRetryFromUpload}
      <button
        type="button"
        class="primary"
        onclick={onRetryFromUpload}
        title="Re-run Upload + Grant only. The encrypted .vsk produced by the last Build is reused — no Oracle re-extract."
      >Retry upload only</button>
    {/if}
  </div>
</div>

<style>
  .banner {
    padding: 12px;
    border-left: 3px solid #ef4444;
    background: rgba(239, 68, 68, 0.1);
    color: var(--error-text, #f87171);
    border-radius: 3px;
    margin: 12px 0;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    margin: 6px 0;
    font-family: monospace;
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    padding: 6px 12px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    font: inherit;
  }
  .primary {
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
  }
</style>
