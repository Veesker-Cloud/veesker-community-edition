<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";

  import { CommandModeState } from "$lib/command/state.svelte";
  import { CommandExecutor, type ExecutorContext } from "$lib/command/executor";
  import { formatPrompt } from "$lib/command/prompt";
  import { sqlEditor } from "$lib/stores/sql-editor.svelte";
  import { connectionCommit, connectionRollback } from "$lib/workspace";

  type Props = {
    connectionId: string;
    user: string | null;
    service: string | null;
    serverVersion?: string | null;
    isProductionLocked: boolean;
    onExit?: (code: number) => void;
  };

  let { connectionId, user, service, serverVersion = null, isProductionLocked, onExit }: Props = $props();

  type LineKind =
    | "echo"
    | "directive-result"
    | "sql-result"
    | "plsql-result"
    | "dbms-output"
    | "error"
    | "info"
    | "echoed-input";

  type DisplayLine = { text: string; kind: LineKind };

  let outputEl = $state<HTMLDivElement | undefined>();
  let inputEl = $state<HTMLInputElement | undefined>();

  let displayLines = $state<DisplayLine[]>([]);
  let currentInput = $state("");
  let running = $state(false);

  let cmdState: CommandModeState | null = null;
  let executor: CommandExecutor | null = null;
  let lastTranscriptLen = 0;

  let historySnapshot: string[] = [];
  let histIdx = -1;
  let savedInput = "";

  function currentPromptStr(): string {
    const lineNum = cmdState ? cmdState.promptLineNumber : 1;
    if (lineNum <= 1) return "SQL> ";
    return formatPrompt({ lineNumber: lineNum, isContinuation: true });
  }

  // Only applied for manual Enter — never for paste lines.
  // Only fires when the statement has its structurally required clauses present.
  const PENDING_ENDINGS = /([,=]|\bOR\b|\bAND\b|\bWHERE\b|\bFROM\b|\bJOIN\b|\bON\b|\bHAVING\b|\bSET\b|\bUNION\b|\bINTERSECT\b|\bMINUS\b)\s*$/i;

  function shouldAutoTerminate(line: string, partialBuffer: string): boolean {
    const t = line.trim();
    if (partialBuffer.length > 0) return false;
    if (!t || t.endsWith(";") || t === "/") return false;
    if (PENDING_ENDINGS.test(t)) return false;
    if (/^\s*SELECT\b/i.test(t)) return /\bFROM\b/i.test(t);
    if (/^\s*INSERT\b/i.test(t)) return /\bVALUES\b|\bSELECT\b/i.test(t);
    if (/^\s*UPDATE\b/i.test(t)) return /\bSET\b/i.test(t);
    if (/^\s*DELETE\b/i.test(t)) return /\bFROM\b/i.test(t);
    if (/^\s*MERGE\b/i.test(t)) return /\bUSING\b/i.test(t);
    return /^\s*(TRUNCATE|COMMIT|ROLLBACK|SAVEPOINT|GRANT|REVOKE|DESCRIBE|DESC|CALL)\b/i.test(t);
  }

  function addBannerLines(): void {
    if (serverVersion) {
      displayLines.push({ text: `Connected to ${serverVersion}`, kind: "info" });
    } else if (service) {
      displayLines.push({ text: `Connected to ${service}`, kind: "info" });
    }
    if (user && service) {
      displayLines.push({ text: `Connected as ${user}@${service}`, kind: "info" });
    } else if (user) {
      displayLines.push({ text: `Connected as ${user}`, kind: "info" });
    }
    displayLines.push({ text: "", kind: "info" });
  }

  function flushTranscript(): void {
    if (!cmdState) return;
    const total = cmdState.transcript.length;
    if (total < lastTranscriptLen) {
      displayLines = [];
      addBannerLines();
      lastTranscriptLen = 0;
    }
    for (let i = lastTranscriptLen; i < total; i++) {
      const entry = cmdState.transcript[i];
      if (entry.kind === "error") {
        displayLines.push({ text: `${entry.code}: ${entry.message}`, kind: "error" });
      } else {
        displayLines.push({ text: entry.text, kind: entry.kind });
      }
    }
    lastTranscriptLen = total;
  }

  async function scrollToBottom(): Promise<void> {
    await tick();
    if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
  }

  // skipAutoTerminate: true when processing pasted lines — bypasses the single-line
  // heuristic that would break multi-line paste (e.g. SELECT col1, col2 on its own
  // line looks "complete" but is just the first line of a multi-line query).
  // skipHistory: true for paste lines — keeps ↑/↓ history clean.
  async function handleSubmit(skipAutoTerminate = false, skipHistory = false): Promise<void> {
    if (!executor || !cmdState || running) return;
    const line = currentInput;
    const trimmed = line.trim().toLowerCase();

    if (trimmed === "clear" || trimmed === "cls") {
      displayLines = [];
      addBannerLines();
      currentInput = "";
      lastTranscriptLen = cmdState.transcript.length;
      await scrollToBottom();
      inputEl?.focus();
      return;
    }

    displayLines.push({ text: `${currentPromptStr()}${line}`, kind: "echoed-input" });

    if (line.trim() && !skipHistory) {
      historySnapshot = [line, ...historySnapshot.slice(0, 999)];
      histIdx = -1;
      savedInput = "";
    }

    currentInput = "";
    running = true;
    const lineToFeed = (!skipAutoTerminate && shouldAutoTerminate(line, cmdState.partialBuffer))
      ? `${line};`
      : line;
    try {
      await executor.feedLine(lineToFeed);
      flushTranscript();
    } finally {
      running = false;
    }
    await scrollToBottom();
    inputEl?.focus();
  }

  // Intercept paste to handle multi-line scripts line by line.
  // Without this, <input type="text"> strips all \n and the entire
  // script arrives as one concatenated string.
  async function handlePaste(e: ClipboardEvent): Promise<void> {
    e.preventDefault();
    if (!cmdState || !executor) return;

    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;

    const lines = text.split(/\r?\n/);

    if (lines.length === 1) {
      // Single-line paste: insert at cursor
      const el = e.currentTarget as HTMLInputElement;
      const start = el.selectionStart ?? currentInput.length;
      const end = el.selectionEnd ?? currentInput.length;
      currentInput = currentInput.slice(0, start) + lines[0] + currentInput.slice(end);
      return;
    }

    // Multi-line paste: first line merges with whatever is already typed.
    // Each line is fed as-is (skipAutoTerminate) so multi-line statements
    // accumulate in the parser buffer correctly.
    currentInput = currentInput + lines[0];
    await handleSubmit(true, true);

    for (let i = 1; i < lines.length - 1; i++) {
      currentInput = lines[i];
      await handleSubmit(true, true);
    }

    // Last fragment stays in the input field for the user to review/complete.
    currentInput = lines[lines.length - 1];
    await scrollToBottom();
    inputEl?.focus();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historySnapshot.length === 0) return;
      if (histIdx === -1) savedInput = currentInput;
      histIdx = Math.min(histIdx + 1, historySnapshot.length - 1);
      currentInput = historySnapshot[histIdx];
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx <= 0) {
        histIdx = -1;
        currentInput = savedInput;
        return;
      }
      histIdx -= 1;
      currentInput = historySnapshot[histIdx];
      return;
    }
    if (e.ctrlKey && e.key === "c") {
      e.preventDefault();
      if (!executor) return;
      displayLines.push({ text: "^C", kind: "info" });
      executor.reset();
      currentInput = "";
      histIdx = -1;
      void scrollToBottom();
    }
  }

  onMount(async () => {
    cmdState = new CommandModeState();

    const ctx: ExecutorContext = {
      connectionId,
      user,
      service,
      isProductionLocked,
      runSql: (sql, _opts) => sqlEditor.runStatementShared(sql, { origin: "user_typed" }),
      runPlsql: (plsql, _opts) => sqlEditor.runStatementShared(plsql, { origin: "user_typed" }),
      commit: () => connectionCommit(),
      rollback: () => connectionRollback(),
      onExit,
    };
    executor = new CommandExecutor(cmdState, ctx);

    addBannerLines();

    try {
      await executor.loadInitialHistory();
      historySnapshot = cmdState.history.map((h) => h.command).reverse();
    } catch (e) {
      console.warn("[CommandWindow] history bootstrap failed:", e);
    }

    await scrollToBottom();
    inputEl?.focus();
  });

  onDestroy(() => {
    executor = null;
    cmdState = null;
  });
</script>

<div class="cw">
  <div class="cw-output" bind:this={outputEl} role="textbox" aria-label="Terminal" aria-multiline="true" tabindex="-1" onclick={() => inputEl?.focus()} onkeydown={() => inputEl?.focus()}>
    {#each displayLines as line}
      <div class="cw-line cw-{line.kind}">{line.text}</div>
    {/each}
    <div class="cw-input-row">
      <span class="cw-prompt">{currentPromptStr()}</span>
      <input
        bind:this={inputEl}
        class="cw-input"
        type="text"
        autocomplete="off"
        autocorrect="off"
        spellcheck={false}
        disabled={running}
        bind:value={currentInput}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
      />
    </div>
  </div>
</div>

<style>
  .cw {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: #0d0d0d;
    font-family: "JetBrains Mono", "SF Mono", "Cascadia Code", monospace;
    font-size: 13px;
    color: #e6dccd;
    box-sizing: border-box;
    overflow: hidden;
  }
  .cw-output {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 12px 8px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
  }
  .cw-line {
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.45;
    min-height: 1.45em;
  }
  .cw-echoed-input { color: #e6dccd; }
  .cw-info { color: #a0a0a0; }
  .cw-error { color: #f5a08a; }
  .cw-dbms-output { color: #6acfe8; }
  .cw-echo { color: #5a5450; }
  .cw-directive-result,
  .cw-sql-result,
  .cw-plsql-result { color: #e6dccd; }
  .cw-input-row {
    display: flex;
    align-items: baseline;
  }
  .cw-prompt {
    color: #a0a0a0;
    white-space: pre;
    flex-shrink: 0;
    user-select: none;
    line-height: 1.45;
  }
  .cw-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: inherit;
    line-height: 1.45;
    padding: 0;
    color: #e6dccd;
    caret-color: #f5a08a;
  }
  .cw-input:disabled { opacity: 0.6; }
</style>
