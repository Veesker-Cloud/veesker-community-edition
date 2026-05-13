<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { writeTextFile } from "@tauri-apps/plugin-fs";
  import { onMount, onDestroy } from "svelte";

  type AuditEntry = {
    ts: string;
    sql: string;
    origin?: string;
    originDetail?: string | null;
    success: boolean;
    rowCount?: number | null;
    elapsedMs?: number;
    errorCode?: number | null;
    errorMessage?: string | null;
    source?: string;
    env?: string;
    connectionId?: string;
    host?: string;
    username?: string;
  };

  const ORIGIN_COLORS: Record<string, string> = {
    user_typed:            "#16a34a",
    user_clicked:          "#2563eb",
    ai_approved:           "#d97706",
    system_background:     "#6b7280",
    schema_browser:        "#0891b2",
    autocomplete_prep:     "#94a3b8",
    sandbox_internal:      "#9333ea",
    embed_batch:           "#a855f7",
    system_identification: "#475569",
  };

  const ORIGIN_LABELS: Record<string, string> = {
    user_typed:            "user typed",
    user_clicked:          "user clicked",
    ai_approved:           "AI approved",
    system_background:     "background",
    schema_browser:        "schema browser",
    autocomplete_prep:     "autocomplete",
    sandbox_internal:      "sandbox",
    embed_batch:           "embed batch",
    system_identification: "system ident",
  };

  let entries = $state<AuditEntry[]>([]);
  let filterOrigins = $state<Set<string>>(new Set());
  let unlisten: UnlistenFn | null = null;
  let loadingInitial = $state(true);

  const filtered = $derived(
    filterOrigins.size === 0
      ? entries
      : entries.filter((e) => filterOrigins.has(e.origin ?? "user_typed")),
  );

  function originColor(origin: string | undefined): string {
    return ORIGIN_COLORS[origin ?? "user_typed"] ?? "#6b7280";
  }

  function originLabel(origin: string | undefined): string {
    return ORIGIN_LABELS[origin ?? "user_typed"] ?? (origin ?? "user_typed");
  }

  onMount(async () => {
    try {
      const initial = await invoke<AuditEntry[]>("audit_recent", { limit: 200 });
      entries = initial;
    } catch {
      // best-effort: empty start is fine
    }
    loadingInitial = false;
    try {
      unlisten = await listen<AuditEntry>("audit:append", (e) => {
        entries = [e.payload, ...entries].slice(0, 500);
      });
    } catch {
      // event listener failure is non-fatal — initial entries still rendered
    }
  });

  onDestroy(() => {
    if (unlisten) unlisten();
  });

  function toggleFilter(origin: string) {
    const next = new Set(filterOrigins);
    if (next.has(origin)) next.delete(origin);
    else next.add(origin);
    filterOrigins = next;
  }

  function clearFilters() {
    filterOrigins = new Set();
  }

  function preview(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function fmtTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function fmtMs(ms: number | undefined): string {
    if (ms === undefined || ms === null) return "—";
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
  }

  // Export the currently filtered view as JSONL via Tauri save dialog.
  async function exportJsonl() {
    const lines = filtered.map((e) => JSON.stringify(e)).join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = await save({
      defaultPath: `veesker-activity-${stamp}.jsonl`,
      filters: [{ name: "JSONL", extensions: ["jsonl"] }],
    });
    if (!path) return;
    await writeTextFile(path, lines);
  }
</script>

<div class="activity-tab">
  <div class="sub-head">
    <span class="count">
      {#if loadingInitial}loading…{:else}{filtered.length} / {entries.length}{/if}
    </span>
    <button class="head-btn" onclick={exportJsonl} title="Export JSONL">Export</button>
  </div>
  <div class="filters">
    {#each Object.keys(ORIGIN_COLORS) as origin (origin)}
      <button
        class="filter-chip"
        class:active={filterOrigins.has(origin)}
        style="--c: {ORIGIN_COLORS[origin]}"
        onclick={() => toggleFilter(origin)}
        title={ORIGIN_LABELS[origin]}
      >
        {ORIGIN_LABELS[origin]}
      </button>
    {/each}
    {#if filterOrigins.size > 0}
      <button class="clear-btn" onclick={clearFilters}>clear</button>
    {/if}
  </div>
  <ul class="entries">
    {#each filtered as entry (entry.ts + ":" + entry.sql.slice(0, 24))}
      <li class="entry" class:err={!entry.success}>
        <div class="entry-head">
          <span class="time">{fmtTime(entry.ts)}</span>
          <span class="origin" style="background: {originColor(entry.origin)}">
            {originLabel(entry.origin)}
          </span>
          <span class="duration">{fmtMs(entry.elapsedMs)}</span>
          <span class="result" class:result-err={!entry.success}>
            {entry.success ? "✓" : "✗"}
          </span>
        </div>
        <code class="sql" title={entry.sql}>{preview(entry.sql)}</code>
        {#if !entry.success && entry.errorMessage}
          <div class="err-msg">{entry.errorMessage}</div>
        {/if}
      </li>
    {/each}
    {#if !loadingInitial && filtered.length === 0}
      <li class="empty">No statements yet.</li>
    {/if}
  </ul>
</div>

<style>
  .activity-tab {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .sub-head {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-surface-alt);
    flex-shrink: 0;
  }
  .count { color: var(--text-muted); font-size: 11px; font-family: "JetBrains Mono", monospace; }
  .head-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  }
  .head-btn:hover { color: var(--text-primary); border-color: var(--border-strong); }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .filter-chip {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: transparent;
    cursor: pointer;
    color: var(--text-muted);
  }
  .filter-chip:hover { color: var(--text-primary); }
  .filter-chip.active {
    background: var(--c);
    color: #fff;
    border-color: var(--c);
  }
  .clear-btn {
    margin-left: auto;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 3px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text-muted);
    text-decoration: underline;
  }

  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
  }
  .entry {
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
  }
  .entry.err { background: rgba(220, 60, 60, 0.06); }
  .entry-head {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 2px;
  }
  .time {
    color: var(--text-muted);
    font-size: 10px;
    font-family: "JetBrains Mono", monospace;
  }
  .origin {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    color: #fff;
    font-weight: 600;
    white-space: nowrap;
  }
  .duration {
    color: var(--text-muted);
    font-size: 10px;
    margin-left: auto;
    font-family: "JetBrains Mono", monospace;
  }
  .result { font-size: 12px; color: #16a34a; font-weight: 700; }
  .result-err { color: #dc2626; }
  .sql {
    display: block;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .err-msg {
    margin-top: 3px;
    font-size: 10px;
    color: #dc2626;
    font-family: "JetBrains Mono", monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 24px 12px;
    color: var(--text-muted);
    text-align: center;
    font-size: 11px;
  }
</style>
