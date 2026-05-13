<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";

  let { open = $bindable(false), onConfirmed }: {
    open?: boolean;
    onConfirmed: () => void;
  } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function confirm() {
    busy = true;
    error = null;
    try {
      await invoke("terminal_confirm_session");
      onConfirmed();
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function cancel() {
    open = false;
  }
</script>

{#if open}
  <div
    class="overlay"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="term-confirm-title"
  >
    <div class="panel">
      <h2 id="term-confirm-title">Open terminal?</h2>
      <p>
        Veesker wants to open a system terminal in this session. The terminal can
        run any shell command as your user account. Only allow this if you started
        the action yourself.
      </p>
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <div class="actions">
        <button onclick={cancel} disabled={busy}>Cancel</button>
        <button class="primary" onclick={confirm} disabled={busy}>
          {busy ? "Confirming..." : "Allow for this session"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    z-index: 1000;
  }
  .panel {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.5rem;
    max-width: 480px;
  }
  .panel h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
  }
  .panel p {
    margin: 0 0 1rem;
  }
  .panel .error {
    color: var(--text-danger, #f88);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .actions button {
    padding: 0.5rem 1rem;
  }
  .actions .primary {
    background: var(--accent, #4a9eff);
    color: white;
  }
</style>
