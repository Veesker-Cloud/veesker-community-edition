<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import { computeFkClosure } from "$lib/sandbox";
  import AvailableSchemaTree from "./tables/AvailableSchemaTree.svelte";
  import GoingToSandboxList from "./tables/GoingToSandboxList.svelte";
  import SummaryPanel from "./tables/SummaryPanel.svelte";
  import FkDepthSlider from "./tables/FkDepthSlider.svelte";
  import AddManualPicker from "./tables/AddManualPicker.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey = "";
  let inFlightToken = 0;

  $effect(() => {
    const conn = wizard.state.source.connectionId;
    const schema = wizard.state.source.schemaName;
    const explicit = wizard.state.tables.explicit.map((t) => t.name);
    const depth = wizard.state.tables.fkDepth;

    if (!conn || !schema) {
      wizard.applyFkClosure({ entries: [], edges: [] });
      lastKey = "";
      return;
    }
    if (explicit.length === 0) {
      wizard.applyFkClosure({ entries: [], edges: [] });
      lastKey = `${conn}|${schema}|0|${depth}`;
      return;
    }

    const key = `${conn}|${schema}|${explicit.slice().sort().join(",")}|${depth}`;
    if (key === lastKey) return;
    lastKey = key;

    if (timer) clearTimeout(timer);
    const myToken = ++inFlightToken;
    timer = setTimeout(() => {
      timer = null;
      computeFkClosure(conn, schema, explicit, depth)
        .then((r) => {
          // Drop late results — user may have advanced steps or changed picks
          // since this RPC was dispatched (250ms debounce + network roundtrip).
          if (myToken !== inFlightToken) return;
          wizard.applyFkClosure(r);
        })
        .catch(() => {
          // keep previous closure on transient errors so the picker doesn't flicker
        });
    }, 250);

    return () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Bump the token so any in-flight RPC dropped on cleanup is also stale.
      inFlightToken += 1;
    };
  });
</script>

{#if wizard.hasE2eExclusionWarning()}
  <div class="banner-warn">
    ⚠ Some FK-pulled tables are excluded — members will lose referential integrity. Queries that JOIN those tables will fail at the member's end.
  </div>
{/if}

<div class="three-pane">
  <AvailableSchemaTree {wizard} />
  <GoingToSandboxList {wizard} />
  <SummaryPanel {wizard} />
</div>

<div class="bottom-strip">
  <FkDepthSlider {wizard} />
  <AddManualPicker {wizard} />
</div>

<style>
  .banner-warn {
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.15);
    color: var(--warn-text, #fbbf24);
    border-left: 3px solid #f59e0b;
    border-radius: 3px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .three-pane {
    display: grid;
    grid-template-columns: 1.1fr 1.4fr 0.9fr;
    gap: 12px;
  }
  .three-pane > :global(*) { min-width: 0; }
  @media (max-width: 1100px) {
    .three-pane { grid-template-columns: 1fr; }
  }
  .bottom-strip {
    display: flex;
    align-items: center;
    gap: 16px;
    padding-top: 12px;
    margin-top: 12px;
    border-top: 1px solid var(--border);
  }
</style>
