<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import type { OpenSandboxResult, QueryResult } from "$lib/sandbox";
  import { querySandbox } from "$lib/sandbox";
  import SchemaList from "./SchemaList.svelte";
  import SandboxQueryEditor from "./SandboxQueryEditor.svelte";
  import SandboxResultGrid from "./SandboxResultGrid.svelte";

  type Props = { active: OpenSandboxResult };
  let { active }: Props = $props();

  let isRunning = $state(false);
  let result = $state<QueryResult | null>(null);
  let queryError = $state<string | null>(null);

  async function run(sql: string) {
    isRunning = true;
    queryError = null;
    try {
      result = await querySandbox(active.sandbox_id, sql);
    } catch (e) {
      queryError = (e as Error).message ?? String(e);
    } finally {
      isRunning = false;
    }
  }
</script>

<div class="open-view">
  <SchemaList tables={active.tables} columns={active.columns} />
  <main class="main">
    <SandboxQueryEditor onRun={run} {isRunning} />
    {#if queryError}
      <div class="error">{queryError}</div>
    {:else if result}
      <SandboxResultGrid columns={result.columns} rows={result.rows} row_count={result.row_count} elapsed_ms={result.elapsed_ms} />
    {:else}
      <div class="placeholder">Run a query to see results.</div>
    {/if}
  </main>
</div>

<style>
  .open-view { display: grid; grid-template-columns: 220px 1fr; height: calc(100vh - 80px); }
  .main { display: flex; flex-direction: column; gap: 8px; padding: 12px; overflow: hidden; }
  .error { padding: 12px; background: #3a1a1a; color: #f88; border-radius: 4px; font-family: monospace; font-size: 12px; }
  .placeholder { padding: 24px; text-align: center; color: var(--text-muted); }
</style>
