<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { sandboxes } from "$lib/stores/sandboxes.svelte";
  import SandboxOpenView from "$lib/workspace/SandboxOpenView.svelte";

  type Props = { data: { sandboxId: string } };
  let { data }: Props = $props();

  onDestroy(() => {
    void sandboxes.close();
  });

  function back() {
    void goto("/sandboxes");
  }
</script>

<header class="open-header">
  <button class="back" onclick={back}>← Sandboxes</button>
  <h2>{sandboxes.active?.sandbox_id === data.sandboxId ? data.sandboxId : "Loading…"}</h2>
</header>

{#if sandboxes.active && sandboxes.active.sandbox_id === data.sandboxId}
  <SandboxOpenView active={sandboxes.active} />
{:else}
  <div class="loading">Opening sandbox…</div>
{/if}

<style>
  .open-header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
  .back { background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; cursor: pointer; color: var(--text-primary); font-size: 12px; }
  h2 { margin: 0; color: var(--text-primary); font-size: 14px; font-family: monospace; }
  .loading { padding: 32px; text-align: center; color: var(--text-muted); }
</style>
