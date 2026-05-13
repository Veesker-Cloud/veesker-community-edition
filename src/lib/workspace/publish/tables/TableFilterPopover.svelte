<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { untrack } from "svelte";

  let {
    tableName,
    initialWhere = "",
    initialRowCap = null,
    onSave,
    onClose,
  }: {
    tableName: string;
    initialWhere?: string;
    initialRowCap?: number | null;
    onSave: (whereClause: string, rowCap: number | null) => void;
    onClose: () => void;
  } = $props();

  let whereClause = $state(untrack(() => initialWhere));
  let rowCap = $state<number | null>(untrack(() => initialRowCap));
  let whereInput: HTMLInputElement | undefined = $state();

  function save() {
    onSave(whereClause, rowCap);
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      save();
    }
  }

  $effect(() => {
    // Move focus into the popover on mount so keyboard users land in the
    // editable field directly, mirroring native dialog UX.
    whereInput?.focus();
  });
</script>

<div
  class="popover"
  role="dialog"
  aria-modal="true"
  aria-label={`Filter for ${tableName}`}
  tabindex="-1"
  onkeydown={onKey}
>
  <header>Filter <code>{tableName}</code></header>
  <label>
    <span>WHERE clause</span>
    <input
      bind:this={whereInput}
      bind:value={whereClause}
      placeholder="created_at >= TRUNC(SYSDATE) - 30"
      maxlength="4096"
    />
  </label>
  <label>
    <span>Row cap (optional)</span>
    <input
      type="number"
      min="1"
      value={rowCap ?? ""}
      oninput={(e) => {
        const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
        rowCap = Number.isFinite(v) && v > 0 ? v : null;
      }}
    />
  </label>
  <p class="warn">⚠ This SQL runs as your Oracle user. Don't paste untrusted input.</p>
  <footer>
    <button type="button" class="btn-secondary" onclick={onClose}>Cancel</button>
    <button type="button" class="btn-primary" onclick={save}>Save</button>
  </footer>
</div>

<style>
  .popover {
    position: absolute;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
    min-width: 300px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 100;
  }
  header { font-weight: bold; margin-bottom: 8px; }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  label input {
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-page);
    color: var(--text-primary);
    font: inherit;
  }
  .warn { font-size: 11px; color: var(--warn-text, #fbbf24); }
  footer { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
  .btn-primary, .btn-secondary {
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    font: inherit;
  }
  .btn-primary { background: var(--accent, #3b82f6); color: white; border: none; }
  .btn-secondary {
    background: var(--bg-surface-alt);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
</style>
