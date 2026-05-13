<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  type Props = {
    initialSql?: string;
    onRun: (sql: string) => void;
    isRunning?: boolean;
  };
  let { initialSql = "SELECT 1", onRun, isRunning = false }: Props = $props();

  let sql = $state(initialSql);
  let textarea: HTMLTextAreaElement | undefined = $state();

  function handleKeydown(e: KeyboardEvent) {
    if ((e.key === "F5") || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      run();
    }
  }

  function run() {
    if (isRunning) return;
    const trimmed = sql.trim();
    if (!trimmed) return;
    onRun(trimmed);
  }
</script>

<div class="qe-wrap">
  <div class="qe-toolbar">
    <button onclick={run} disabled={isRunning}>
      {isRunning ? "Running…" : "▶ Run (F5)"}
    </button>
    <span class="hint">Ctrl/Cmd+Enter or F5</span>
  </div>
  <textarea
    bind:this={textarea}
    bind:value={sql}
    onkeydown={handleKeydown}
    placeholder="SELECT * FROM ..."
    spellcheck="false"
  ></textarea>
</div>

<style>
  .qe-wrap { display: flex; flex-direction: column; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; }
  .qe-toolbar { display: flex; align-items: center; gap: 12px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  button { padding: 4px 12px; background: var(--bg-surface-alt); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:disabled { cursor: not-allowed; opacity: 0.5; }
  .hint { font-size: 11px; color: var(--text-muted); }
  textarea {
    flex: 1; min-height: 200px;
    background: var(--bg-page); color: var(--text-primary);
    border: none; padding: 12px; font-family: monospace; font-size: 13px;
    resize: vertical; outline: none;
  }
</style>
