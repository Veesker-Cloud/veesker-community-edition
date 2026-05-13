<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { sandboxKeypair } from "$lib/stores/sandbox-keypair.svelte";

  type Props = { onClose: () => void };
  let { onClose }: Props = $props();

  let confirming = $state(false);

  async function regenerate() {
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    sandboxKeypair.reset();
    await sandboxKeypair.ensure();
  }

  async function retry() {
    await sandboxKeypair.ensure();
  }

  function onModalKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    // Escape closes the modal — but never while a destructive confirm is
    // pending (otherwise a stray Esc voids the in-flight confirm intent).
    if (e.key === "Escape" && !confirming) onClose();
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={() => {
    // Same intent guard as Escape — overlay click should not silently
    // discard a mid-confirm regenerate flow.
    if (!confirming) onClose();
  }}
></div>
<div
  class="modal"
  role="dialog"
  aria-modal="true"
  aria-label="Sandbox Encryption"
  tabindex="-1"
  onclick={(e) => e.stopPropagation()}
  onkeydown={onModalKeydown}
>
  <h3>Sandbox Encryption</h3>

  {#if sandboxKeypair.loading}
    <p>Setting up encryption…</p>
  {:else if sandboxKeypair.error}
    <p class="error">⚠ Setup failed: {sandboxKeypair.error}</p>
    <button type="button" onclick={retry}>Retry</button>
  {:else if sandboxKeypair.isRegistered}
    <p class="status">✓ Encryption keypair registered.</p>
    <p class="hint">
      Public key: <code>{sandboxKeypair.pubkey_b64?.slice(0, 16)}…</code><br>
      Registered at: {sandboxKeypair.registered_at}
    </p>
    <hr>
    <p class="warn">Regenerating creates a new keypair. <strong>You will lose access to existing sandboxes</strong> until owners re-share them with your new key.</p>
    <button type="button" class={confirming ? "danger" : ""} onclick={regenerate}>
      {confirming ? "Click again to confirm regenerate" : "Regenerate keypair"}
    </button>
  {:else}
    <p>Keypair not yet registered.</p>
    <button type="button" onclick={retry}>Set up now</button>
  {/if}

  <button
    type="button"
    class="close"
    onclick={onClose}
    disabled={confirming}
    title={confirming ? "Cancel the regenerate confirm first" : ""}
  >Close</button>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 99;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 24px;
    max-width: 480px;
    width: calc(100% - 32px);
    z-index: 100;
  }
  h3 { margin: 0 0 12px; color: var(--text-primary); }
  p { color: var(--text-muted); margin: 8px 0; }
  .status { color: #10b981; }
  .error { color: #ef4444; }
  .warn {
    background: rgba(245, 158, 11, 0.15);
    color: var(--warn-text, #fbbf24);
    padding: 8px;
    border-radius: 4px;
    font-size: 12px;
    border-left: 3px solid #f59e0b;
  }
  .hint { font-family: monospace; font-size: 11px; }
  hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
  button {
    padding: 6px 16px;
    background: var(--bg-surface-alt);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    margin-top: 8px;
    margin-right: 8px;
    font: inherit;
  }
  button.danger {
    background: rgba(239, 68, 68, 0.15);
    color: var(--error-text, #f87171);
    border-color: rgba(239, 68, 68, 0.4);
  }
  button.close { float: right; }
  code {
    background: var(--bg-surface-alt);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
  }
</style>
