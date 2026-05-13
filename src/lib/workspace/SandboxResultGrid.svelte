<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import type { QueryColumn } from "$lib/sandbox";

  type Props = {
    columns: QueryColumn[];
    rows: unknown[][];
    row_count: number;
    elapsed_ms: number;
  };
  let { columns, rows, row_count, elapsed_ms }: Props = $props();

  type SortDir = "asc" | "desc" | "none";
  let sortCol = $state<number | null>(null);
  let sortDir = $state<SortDir>("none");

  const sortedRows = $derived.by(() => {
    if (sortCol === null || sortDir === "none") return rows;
    const c = sortCol;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[c], bv = b[c];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  });

  function toggleSort(idx: number) {
    if (sortCol !== idx) {
      sortCol = idx;
      sortDir = "asc";
    } else if (sortDir === "asc") {
      sortDir = "desc";
    } else {
      sortCol = null;
      sortDir = "none";
    }
  }

  function fmtCell(v: unknown): string {
    if (v === null || v === undefined) return "<NULL>";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Uint8Array) return `<BLOB ${v.length} bytes>`;
    return JSON.stringify(v);
  }

  const ROW_HEIGHT = 24;
  const OVERSCAN = 10;

  let scrollEl = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let containerH = $state(400);

  $effect(() => {
    const el = scrollEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { containerH = el.clientHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  });

  let visibleSlice = $derived.by(() => {
    const total = sortedRows.length;
    if (total === 0) return { start: 0, end: 0, topPad: 0, botPad: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(total, Math.ceil((scrollTop + containerH) / ROW_HEIGHT) + OVERSCAN);
    return { start, end, topPad: start * ROW_HEIGHT, botPad: (total - end) * ROW_HEIGHT };
  });
</script>

<div class="rg-wrap">
  <div class="rg-header">
    <span>{row_count} row{row_count === 1 ? "" : "s"}</span>
    <span>{elapsed_ms}ms</span>
  </div>
  {#if rows.length === 0}
    <div class="rg-empty">No results.</div>
  {:else}
    <div
      class="rg-scroll"
      bind:this={scrollEl}
      onscroll={(e) => { scrollTop = (e.currentTarget as HTMLDivElement).scrollTop; }}
    >
      <table>
        <thead>
          <tr>
            {#each columns as col, i}
              <th onclick={() => toggleSort(i)}>
                <span class="cn">{col.name}</span>
                <span class="ct">{col.type}</span>
                {#if sortCol === i}<span class="sort">{sortDir === "asc" ? "▲" : "▼"}</span>{/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#if visibleSlice.topPad > 0}
            <tr class="spacer" style="height:{visibleSlice.topPad}px"><td colspan={columns.length}></td></tr>
          {/if}
          {#each sortedRows.slice(visibleSlice.start, visibleSlice.end) as row, vi (visibleSlice.start + vi)}
            <tr>
              {#each row as cell}
                <td class:nul={cell === null || cell === undefined}>{fmtCell(cell)}</td>
              {/each}
            </tr>
          {/each}
          {#if visibleSlice.botPad > 0}
            <tr class="spacer" style="height:{visibleSlice.botPad}px"><td colspan={columns.length}></td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .rg-wrap { display: flex; flex-direction: column; height: 100%; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; }
  .rg-header { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  .rg-empty { padding: 16px; text-align: center; color: var(--text-muted); }
  .rg-scroll { overflow: auto; flex: 1; }
  table { border-collapse: collapse; width: 100%; }
  th { background: var(--bg-surface-alt); padding: 6px 10px; text-align: left; cursor: pointer; user-select: none; font-size: 11px; border-bottom: 1px solid var(--border); }
  th .cn { color: var(--text-primary); font-weight: 600; }
  th .ct { color: var(--text-muted); margin-left: 6px; font-size: 9px; }
  th .sort { margin-left: 6px; color: var(--text-muted); }
  td { padding: 4px 10px; font-size: 12px; color: var(--text-primary); border-bottom: 1px solid var(--border); font-family: monospace; }
  td.nul { color: var(--text-muted); font-style: italic; }
  tr.spacer { background: none; cursor: default; }
  tr.spacer:hover { background: none; }
</style>
