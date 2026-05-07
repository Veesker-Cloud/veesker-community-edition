<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  import { CommandModeState, type TranscriptEntry } from "$lib/command/state.svelte";
  import { CommandExecutor, type ExecutorContext } from "$lib/command/executor";
  import { LineEditor, type LineEditorOutput } from "$lib/command/line-editor";
  import { formatConnectionLabel, formatPrompt } from "$lib/command/prompt";
  import { decodeXtermInput } from "$lib/command/command-input-decoder";
  import { sqlEditor } from "$lib/stores/sql-editor.svelte";
  import { connectionCommit, connectionRollback } from "$lib/workspace";

  type Props = {
    connectionId: string;
    user: string | null;
    service: string | null;
    isProductionLocked: boolean;
    onExit?: (code: number) => void;
  };

  let {
    connectionId,
    user,
    service,
    isProductionLocked,
    onExit,
  }: Props = $props();

  const ANSI_RESET = "\x1b[0m";
  const ANSI_RED = "\x1b[31m";
  const ANSI_GREEN = "\x1b[32m";
  const ANSI_YELLOW = "\x1b[33m";
  const ANSI_CYAN = "\x1b[36m";
  const ANSI_GRAY = "\x1b[90m";
  const ANSI_BOLD = "\x1b[1m";

  let host: HTMLDivElement | undefined = $state();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let cmdState: CommandModeState | null = null;
  let executor: CommandExecutor | null = null;
  let editor: LineEditor | null = null;
  let lastTranscriptLen = 0;
  let suppressNextCr = true;

  function writeLines(text: string): void {
    if (!term) return;
    term.write(text.replace(/\r?\n/g, "\r\n"));
  }

  function writeBanner(): void {
    if (!term) return;
    term.write(`${ANSI_BOLD}SQL*Plus-compatible Command Mode (Veesker)${ANSI_RESET}\r\n`);
    const label = formatConnectionLabel(user, service).replace(/>$/, "");
    if (label.length > 0) {
      let connLine = `Connected to: ${ANSI_GREEN}${label}${ANSI_RESET}`;
      if (isProductionLocked) {
        connLine += ` ${ANSI_RED}[PROD]${ANSI_RESET}`;
      }
      term.write(`${connLine}\r\n`);
    } else if (isProductionLocked) {
      term.write(`Connected. ${ANSI_RED}[PROD]${ANSI_RESET}\r\n`);
    } else {
      term.write("Connected.\r\n");
    }
    term.write("\r\n");
    term.write(
      `${ANSI_GRAY}Type @file.sql to run a script. Type EXIT to disconnect.${ANSI_RESET}\r\n\r\n`,
    );
  }

  function currentPrompt(): string {
    const lineNumber = cmdState ? cmdState.promptLineNumber : 1;
    return formatPrompt({ lineNumber, isContinuation: lineNumber > 1 });
  }

  function drawPromptFresh(): void {
    if (!term) return;
    if (suppressNextCr) {
      suppressNextCr = false;
      term.write(currentPrompt());
      return;
    }
    term.write(`\r\n${currentPrompt()}`);
  }

  function redraw(buffer: string, cursor: number): void {
    if (!term) return;
    term.write("\r\x1b[2K");
    const prompt = currentPrompt();
    term.write(prompt);
    term.write(buffer);
    const overshoot = buffer.length - cursor;
    if (overshoot > 0) {
      term.write(`\x1b[${overshoot}D`);
    }
  }

  function writeTranscriptEntry(entry: TranscriptEntry): void {
    if (!term) return;
    switch (entry.kind) {
      case "echo":
        writeLines(`${ANSI_GRAY}${entry.text}${ANSI_RESET}`);
        return;
      case "directive-result":
      case "info":
        writeLines(entry.text);
        return;
      case "sql-result":
      case "plsql-result":
        writeLines(entry.text);
        return;
      case "dbms-output":
        writeLines(`${ANSI_CYAN}${entry.text}${ANSI_RESET}`);
        return;
      case "error":
        writeLines(`${ANSI_RED}${entry.code}: ${entry.message}${ANSI_RESET}\n`);
        return;
    }
  }

  function flushTranscript(): void {
    if (!cmdState || !term) return;
    const total = cmdState.transcript.length;
    if (total < lastTranscriptLen) {
      term.clear();
      suppressNextCr = true;
      writeBanner();
      lastTranscriptLen = 0;
    }
    for (let i = lastTranscriptLen; i < total; i++) {
      writeTranscriptEntry(cmdState.transcript[i]);
    }
    lastTranscriptLen = total;
  }

  async function commitWrapper() {
    return connectionCommit();
  }

  async function rollbackWrapper() {
    return connectionRollback();
  }

  function handleEditorOutputs(outputs: LineEditorOutput[]): void {
    if (!term || !editor || !executor) return;
    for (const out of outputs) {
      if (out.kind === "redraw") {
        redraw(out.buffer, out.cursor);
      } else if (out.kind === "submit") {
        void handleSubmit(out.line);
      } else if (out.kind === "interrupt") {
        term.write(`\r\n${ANSI_YELLOW}^C${ANSI_RESET}\r\n`);
        executor.reset();
        suppressNextCr = true;
        drawPromptFresh();
      } else if (out.kind === "clear-screen") {
        term.clear();
        suppressNextCr = true;
        writeBanner();
        drawPromptFresh();
      }
    }
  }

  async function handleSubmit(line: string): Promise<void> {
    if (!term || !cmdState || !editor || !executor) return;
    term.write("\r\n");
    if (line.trim() !== "") {
      editor.pushHistory(line);
    }
    await executor.feedLine(line);
    flushTranscript();
    drawPromptFresh();
  }

  function bufferIsEmpty(): boolean {
    if (!editor) return true;
    return editor.getBuffer() === "";
  }

  function handleData(data: string): void {
    if (!editor) return;
    const decoded = decodeXtermInput(data, { bufferIsEmpty: bufferIsEmpty() });
    if (decoded.kind === "exit-on-empty") {
      onExit?.(0);
      return;
    }
    for (const ev of decoded.events) {
      const outputs = editor.handle(ev);
      handleEditorOutputs(outputs);
    }
  }

  onMount(async () => {
    if (!host) return;

    cmdState = new CommandModeState();
    editor = new LineEditor({ historyLimit: 1000 });

    const ctx: ExecutorContext = {
      connectionId,
      user,
      service,
      isProductionLocked,
      runSql: (sql, _opts) =>
        sqlEditor.runStatementShared(sql, { origin: "user_typed" }),
      runPlsql: (plsql, _opts) =>
        sqlEditor.runStatementShared(plsql, { origin: "user_typed" }),
      commit: commitWrapper,
      rollback: rollbackWrapper,
      onExit,
    };
    executor = new CommandExecutor(cmdState, ctx);

    term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      theme: {
        background: "#0e0c0a",
        foreground: "#e6dccd",
        cursor: "#f5a08a",
        cursorAccent: "#0e0c0a",
        selectionBackground: "rgba(245,160,138,0.25)",
        black: "#1a1610",
        red: "#f5a08a",
        green: "#7ec96a",
        yellow: "#e8c87e",
        blue: "#6aa0f5",
        magenta: "#c48af0",
        cyan: "#6acfe8",
        white: "#c9c4be",
        brightBlack: "#5a5450",
        brightRed: "#f5bfaf",
        brightGreen: "#9fe88a",
        brightYellow: "#f0d89e",
        brightBlue: "#8abcff",
        brightMagenta: "#d4a8f8",
        brightCyan: "#8ae0f5",
        brightWhite: "#e8e4df",
      },
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    suppressNextCr = true;
    writeBanner();

    try {
      await executor.loadInitialHistory();
      editor.setHistory(cmdState.history.map((h) => h.command));
    } catch (e) {
      console.warn("[CommandWindow] history bootstrap failed:", e);
    }

    flushTranscript();
    drawPromptFresh();

    term.onData(handleData);

    resizeObserver = new ResizeObserver(() => {
      fit?.fit();
    });
    resizeObserver.observe(host);

    term.focus();
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    term?.dispose();
    term = null;
    fit = null;
    editor = null;
    executor = null;
    cmdState = null;
  });
</script>

<div class="command-window">
  <div bind:this={host} class="term-host"></div>
</div>

<style>
  .command-window {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: #0e0c0a;
    box-sizing: border-box;
    overflow: hidden;
  }
  .term-host {
    flex: 1;
    min-height: 0;
    padding: 6px 8px 0 8px;
  }
  :global(.command-window .xterm-viewport) {
    background: transparent !important;
  }
</style>
