<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import { lookupUserByEmail } from "$lib/sandbox";
  import RecipientChip from "./RecipientChip.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  let value = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function commit() {
    // Guard against double-fire: pressing Enter blurs the input on most
    // browsers, which fires onblur → second commit() in flight while the
    // first is still awaiting lookupUserByEmail. The dedup-by-email guard
    // below is synchronous so both calls would pass it before either resolves.
    if (busy) return;
    const email = value.trim().toLowerCase();
    if (email === "") return;
    if (wizard.state.spec.recipients.some((r) => r.email === email)) {
      value = "";
      return;
    }
    busy = true;
    error = null;
    try {
      const lookup = await lookupUserByEmail(email);
      wizard.addRecipient({
        email,
        userId: lookup?.userId ?? null,
        pubkeyOk: lookup !== null,
      });
      value = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    }
  }
</script>

<div class="block">
  <div class="row">
    <input
      type="text"
      placeholder="email or user-id"
      bind:value
      onkeydown={onkey}
      disabled={busy}
      aria-label="Recipient email"
    />
    <button
      type="button"
      onclick={() => void commit()}
      disabled={busy || value.trim() === ""}
      aria-label="Add recipient"
    >+</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  {#if wizard.state.spec.recipients.length > 0}
    <ul class="chips">
      {#each wizard.state.spec.recipients as r (r.email)}
        <li>
          <RecipientChip
            email={r.email}
            userId={r.userId}
            pubkeyOk={r.pubkeyOk}
            onRemove={() => wizard.removeRecipient(r.email)}
          />
        </li>
      {/each}
    </ul>
  {/if}
  {#if wizard.state.spec.recipients.length > 20}
    <p class="warn">⚠ Large recipient lists slow encryption — consider batching.</p>
  {/if}
</div>

<style>
  .block { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .row button {
    padding: 4px 12px;
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-weight: bold;
  }
  .row button:disabled {
    background: var(--bg-surface-alt);
    color: var(--text-muted);
    cursor: not-allowed;
  }
  input {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-page);
    color: var(--text-primary);
    font: inherit;
  }
  .chips {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .error { color: #ef4444; font-size: 12px; margin: 0; }
  .warn { color: var(--warn-text, #fbbf24); font-size: 12px; margin: 0; }
</style>
