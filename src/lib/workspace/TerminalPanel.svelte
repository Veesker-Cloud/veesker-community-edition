<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import "@xterm/xterm/css/xterm.css";
  import TerminalConfirmModal from "./TerminalConfirmModal.svelte";

  type Props = {
    onClose: () => void;
    onMinimize?: () => void;
    onDockToggle?: () => void;
    minimized?: boolean;
    dock?: "bottom" | "right";
  };

  let { onClose, onMinimize, onDockToggle, minimized = false, dock = "bottom" }: Props = $props();

  let host = $state<HTMLDivElement | undefined>();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let termId: string | null = null;
  let unlistenData: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let dead = $state(false);
  let confirmModalOpen = $state(false);
  let pendingTerminalParams = $state<{ cols: number; rows: number } | null>(null);

  async function startTerminal(cols: number, rows: number) {
    if (!term || !host) return;
    try {
      termId = await invoke<string>("terminal_create", { cols, rows });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("user_confirmation_required")) {
        pendingTerminalParams = { cols, rows };
        confirmModalOpen = true;
        return;
      }
      term.write(`\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m\r\n`);
      return;
    }

    unlistenData = await listen<string>(`terminal:data:${termId}`, (ev) => {
      term?.write(ev.payload);
    });

    unlistenExit = await listen(`terminal:exit:${termId}`, () => {
      dead = true;
      term?.write("\r\n\x1b[2m[process exited — press any key to close]\x1b[0m\r\n");
    });

    term.onData((data) => {
      if (dead) { onClose(); return; }
      if (termId) invoke("terminal_write", { id: termId, data }).catch(() => {});
    });

    resizeObserver = new ResizeObserver(() => {
      if (!host || host.clientWidth === 0) return;
      fit?.fit();
      if (term && termId) {
        invoke("terminal_resize", { id: termId, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    });
    resizeObserver.observe(host);

    term.focus();
  }

  async function onConfirmed() {
    if (!pendingTerminalParams) return;
    const { cols, rows } = pendingTerminalParams;
    pendingTerminalParams = null;
    try {
      await startTerminal(cols, rows);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      term?.write(`\r\n\x1b[31mFailed to open terminal: ${msg}\x1b[0m\r\n`);
    }
  }

  onMount(async () => {
    if (!host) return;

    term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#0e0c0a",
        foreground: "#c9c4be",
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
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 5000,
    });

    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const { cols, rows } = term;
    await startTerminal(cols, rows);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    unlistenData?.();
    unlistenExit?.();
    term?.dispose();
    if (termId) invoke("terminal_close", { id: termId }).catch(() => {});
  });

  // Re-fit xterm when panel is restored from minimized state
  $effect(() => {
    if (!minimized) setTimeout(() => { fit?.fit(); term?.focus(); }, 30);
  });

  export function focus() {
    term?.focus();
  }
</script>

<div class="tp-wrap">
  <div class="tp-bar">
    <span class="tp-label">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/>
        <polyline points="3.5,4.5 5.5,6.5 3.5,8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="6.5" y1="8.5" x2="9" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
      Terminal
    </span>
    <div class="tp-actions">
      <button
        class="tp-btn"
        aria-label={dock === 'right' ? "Move to bottom" : "Move to right"}
        title={dock === 'right' ? "Move to bottom panel" : "Move to right panel"}
        onclick={onDockToggle}
      >
        {#if dock === 'right'}
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <rect x="1" y="9" width="12" height="4" rx="0" fill="currentColor" opacity="0.35"/>
            <line x1="1" y1="9" x2="13" y2="9" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        {:else}
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <rect x="8" y="1" width="5" height="12" rx="0" fill="currentColor" opacity="0.35"/>
            <line x1="8" y1="1" x2="8" y2="13" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        {/if}
      </button>
      {#if onMinimize}
        <button
          class="tp-btn"
          aria-label={minimized ? "Restore terminal" : "Minimize terminal"}
          title={minimized ? "Restore" : "Minimize"}
          onclick={onMinimize}
        >
          {#if minimized}
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <polyline points="2,9 6,5 10,9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {:else}
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <polyline points="2,4 6,8 10,4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {/if}
        </button>
      {/if}
      <button class="tp-btn" aria-label="Close terminal" onclick={onClose} title="Close (Ctrl+`)">×</button>
    </div>
  </div>
  <div bind:this={host} class="tp-host" class:tp-host-hidden={minimized}></div>
</div>

<TerminalConfirmModal bind:open={confirmModalOpen} {onConfirmed} />

<style>
  .tp-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0e0c0a;
    overflow: hidden;
  }
  .tp-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    height: 28px;
    flex-shrink: 0;
    background: rgba(255,255,255,0.03);
    border-bottom: 1px solid rgba(255,255,255,0.07);
    position: relative;
    z-index: 30;
  }
  .tp-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    font-family: "Space Grotesk", sans-serif;
    font-weight: 600;
    color: rgba(255,255,255,0.45);
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }
  .tp-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tp-btn {
    background: transparent;
    border: none;
    color: rgba(255,255,255,0.25);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 4px;
    height: 22px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tp-btn:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.06); }
  .tp-host {
    flex: 1;
    overflow: hidden;
    padding: 4px 8px;
  }
  .tp-host-hidden { display: none; }
</style>
