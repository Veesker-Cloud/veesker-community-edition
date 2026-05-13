<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { discoverPlsql } from "$lib/sandbox";
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";

  type Props = { wizard: PublishWizard };
  let { wizard }: Props = $props();

  type DiscoveredObject = {
    kind: "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE" | "VIEW";
    owner: string;
    name: string;
    refPath: string[];
  };

  const KINDS = ["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "VIEW"] as const;
  const KIND_LABELS: Record<string, string> = {
    PROCEDURE: "Procedures",
    FUNCTION: "Functions",
    PACKAGE: "Packages",
    TRIGGER: "Triggers",
    TYPE: "Types",
    VIEW: "Views",
  };
  const TEN_MB = 10_000_000;

  const grouped = $derived((() => {
    const out: Record<string, DiscoveredObject[]> = {};
    for (const k of KINDS) out[k] = [];
    for (const o of wizard.state.plsql.discovered) {
      (out[o.kind] ??= []).push(o as DiscoveredObject);
    }
    return out;
  })());

  const totalSelected = $derived(wizard.getEffectiveSelectedCount());
  const totalDiscovered = $derived(wizard.state.plsql.discovered.length);
  const sizeKB = $derived(Math.round(wizard.state.plsql.estimatedTotalBytes / 1024));
  const overSizeWarning = $derived(wizard.state.plsql.estimatedTotalBytes > TEN_MB);

  onMount(async () => {
    if (wizard.state.plsql.discoveryStatus === "ok") return;
    wizard.setPlsqlDiscoveryStatus("running");
    try {
      const conn = wizard.state.source.connectionId;
      const schema = wizard.state.source.schemaName;
      if (!conn || !schema) {
        wizard.setPlsqlDiscoveryStatus("error", "missing connection or schema");
        return;
      }
      const tableNames = wizard.effectiveTables().map((t) => t.name);
      const r = await discoverPlsql(conn, schema, tableNames);
      wizard.setPlsqlDiscovery(r.objects as DiscoveredObject[], r.totalEstimatedDdlBytes);
    } catch (e) {
      wizard.setPlsqlDiscoveryStatus("error", e instanceof Error ? e.message : String(e));
    }
  });

  function isExcluded(o: DiscoveredObject): boolean {
    return wizard.state.plsql.excluded.has(`${o.kind}:${o.owner}:${o.name}`);
  }
</script>

{#if wizard.state.plsql.discoveryStatus === "running"}
  <div class="loading">
    <div class="spinner" aria-hidden="true"></div>
    <span>Discovering PL/SQL…</span>
  </div>
{:else if wizard.state.plsql.discoveryStatus === "error"}
  <div class="error" role="alert">
    Failed to discover PL/SQL: {wizard.state.plsql.discoveryError ?? "unknown error"}
  </div>
{:else}
  <header class="title">
    <h2>Review PL/SQL</h2>
    <p class="subtitle">
      Discovered {totalDiscovered} PL/SQL objects via dependency walk from your selected tables.
    </p>
  </header>
  {#if overSizeWarning}
    <div class="warn-banner" role="alert">
      ⚠ Large sandbox — estimated {sizeKB.toLocaleString()} KB. Consider reducing scope.
    </div>
  {/if}
  <ul class="kind-groups">
    {#each KINDS as kind (kind)}
      {#if grouped[kind]?.length}
        <li class="kind">
          <header class="kind-header">
            <span>▼ {KIND_LABELS[kind]} ({grouped[kind].length})</span>
            <button
              type="button"
              class="kind-action"
              onclick={() => wizard.unselectKind(kind)}
            >unselect</button>
            <button
              type="button"
              class="kind-action"
              onclick={() => wizard.selectKind(kind)}
            >select</button>
          </header>
          <ul class="objects">
            {#each grouped[kind] as obj (`${obj.owner}.${obj.name}`)}
              <li>
                <label>
                  <input
                    type="checkbox"
                    aria-label="{obj.owner}.{obj.name}"
                    checked={!isExcluded(obj)}
                    onchange={() => wizard.togglePlsql(obj.kind, obj.owner, obj.name)}
                  />
                  <span class="obj-name">{obj.owner}.{obj.name}</span>
                  {#if obj.refPath.length}
                    <span class="ref-path" title="depends on {obj.refPath.slice(0, -1).join(' → ')}">ⓘ</span>
                  {/if}
                </label>
              </li>
            {/each}
          </ul>
        </li>
      {/if}
    {/each}
  </ul>
  <footer class="totals">
    Total selected: {totalSelected} / {totalDiscovered} · Estimated size: {sizeKB.toLocaleString()} KB
  </footer>
{/if}

<style>
  .loading { display: flex; align-items: center; gap: 12px; padding: 24px; color: var(--text-muted); }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent, #3b82f6); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { padding: 16px; background: var(--bg-surface-alt); border: 1px solid #c33; border-radius: 4px; color: #c33; }
  .title h2 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { font-size: 13px; color: var(--text-muted); margin: 0 0 16px; }
  .warn-banner { padding: 8px 12px; background: var(--bg-surface-alt); border: 1px solid var(--border); border-radius: 4px; font-size: 13px; margin-bottom: 16px; color: var(--text-primary); }
  .kind-groups { list-style: none; padding: 0; margin: 0; }
  .kind { border-top: 1px solid var(--border); padding: 8px 0; }
  .kind-header { display: flex; gap: 8px; align-items: center; font-weight: 600; font-size: 14px; }
  .kind-action { background: transparent; border: none; color: var(--accent, #3b82f6); cursor: pointer; font-size: 12px; }
  .objects { list-style: none; padding-left: 16px; margin: 4px 0 0; }
  .objects li { padding: 2px 0; font-size: 13px; }
  .obj-name { font-family: var(--font-mono, monospace); }
  .ref-path { color: var(--text-muted); margin-left: 6px; cursor: help; }
  .totals { padding: 12px 0; font-size: 13px; color: var(--text-muted); border-top: 1px solid var(--border); margin-top: 8px; }
</style>
