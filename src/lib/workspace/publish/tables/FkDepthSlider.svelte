<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  function onInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    wizard.setFkDepth(Number.isFinite(v) ? v : 1);
  }
</script>

<div class="row">
  <span>FK depth:</span>
  <input
    type="range"
    min="1"
    max="5"
    value={wizard.state.tables.fkDepth}
    oninput={onInput}
    aria-label="FK walk depth"
  />
  <strong>{wizard.state.tables.fkDepth}</strong>
  <span class="muted">/ 5</span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    color: var(--text-primary);
  }
  input[type=range] { flex: 1; max-width: 240px; }
  .muted { color: var(--text-muted); }
</style>
