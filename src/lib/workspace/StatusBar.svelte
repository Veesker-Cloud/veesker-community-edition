<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { sqlEditor } from "$lib/stores/sql-editor.svelte";
  import { getContext } from "svelte";
  import VeeskerMark from "$lib/VeeskerMark.svelte";
  import { shouldShowUserHost, txButtonState } from "./status-bar-helpers";

  type Props = {
    connectionName: string;
    userLabel: string;
    schema: string;
    serverVersion: string;
    hasPendingTx?: boolean;
    /** Item #4 Fase B: count of uncommitted statements (DML/DDL/PLSQL/TCL). */
    pendingTxCount?: number;
    chatOpen?: boolean;
    onToggleChat?: () => void;
    onDisconnect: () => void;
    onSwitchConnection: () => void;
    theme?: "light" | "dark";
    onToggleTheme?: () => void;
    env?: "dev" | "staging" | "prod";
    readOnly?: boolean;
    /** L1.2 (Sprint C): when true, render the air-gap badge. */
    airgap?: boolean;
    /** L2.1 PSDPM (PL/SQL Developer Parity Mode) — surfaces a 🔐 PSDPM badge. */
    psdpm?: boolean;
    onSignIn?: () => void;
    onAuditLog?: () => void;
    onSignOut?: () => void;
    username?: string;
    serviceName?: string;
    onCommit?: () => void;
    onRollback?: () => void;
  };
  let {
    connectionName, userLabel, schema, serverVersion,
    hasPendingTx = false, pendingTxCount = 0, chatOpen = false, onToggleChat,
    onDisconnect, onSwitchConnection,
    theme = "light", onToggleTheme,
    env, readOnly = false, airgap = false, psdpm = false,
    onSignIn, onAuditLog, onSignOut,
    username = "",
    serviceName = "",
    onCommit,
    onRollback,
  }: Props = $props();

  const authCtx = getContext<{ tier: "ce" | "cloud"; email: string }>("auth");
  let showCloudMenu = $state(false);

  // Shorten version: "Oracle AI Database 26ai Free Release 23.26.1.0.0 – ..." → "23.26.1.0.0"
  const shortVersion = $derived(
    (() => {
      const m = serverVersion.match(/(\d+\.\d+[\d.]*)/);
      return m ? m[1] : serverVersion.split(" ").slice(0, 3).join(" ");
    })()
  );

  const showUserHost = $derived(shouldShowUserHost(username, serviceName));
  const commitState = $derived(txButtonState(hasPendingTx ?? false));
  const rollbackState = $derived(txButtonState(hasPendingTx ?? false));
</script>

<div class="bar" class:bar-prod={env === "prod"} class:bar-staging={env === "staging"}>
  <!-- Left: connection identity -->
  <div class="bar-left">
    <VeeskerMark size={22} bg={false} class="bar-mark" />
    <span class="bar-divider" aria-hidden="true"></span>
    <span class="conn-dot" aria-label="Connected"></span>
    <span class="conn-name">{connectionName}</span>
    {#if env}
      <span class="env-badge env-{env}" title="Environment tag — set on the connection">{env}</span>
    {/if}
    {#if readOnly}
      <span class="ro-badge" title="Read-only — DML/DDL blocked on this connection">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
          <rect x="1.5" y="3.5" width="6" height="4.5" rx="0.6" stroke="currentColor" stroke-width="1"/>
          <path d="M3 3.5V2.5a1.5 1.5 0 013 0v1" stroke="currentColor" stroke-width="1" fill="none"/>
        </svg>
        RO
      </span>
    {/if}
    <!-- L1.2 air-gap badge -->
    {#if airgap}
      <span
        class="bar-airgap"
        title="Air-gap mode is active for this connection. Outbound network calls (AI, cloud sync, version remote) are disabled."
      >
        🔒 AIR-GAPPED
      </span>
    {/if}
    <!-- L2.1 PSDPM badge -->
    {#if psdpm}
      <span class="bar-psdpm" title="PSDPM active: only user-initiated SQL runs against this connection">
        🔐 PSDPM
      </span>
    {/if}
    {#if hasPendingTx}
      <span
        class="tx-badge tx-badge-{env ?? 'dev'}"
        title="{pendingTxCount > 0 ? `${pendingTxCount} uncommitted statement${pendingTxCount === 1 ? '' : 's'}` : 'Uncommitted transaction'} pending — remember to COMMIT or ROLLBACK"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
          <circle cx="4" cy="4" r="3.5" fill="currentColor"/>
        </svg>
        TX{pendingTxCount > 0 ? ` ${pendingTxCount}` : ""}
      </span>
    {/if}
    {#if showUserHost}
      <span class="bar-divider" aria-hidden="true"></span>
      <span class="userhost" title="Connected as {username} on service {serviceName}">
        {username}@{serviceName}
      </span>
    {/if}
    <span class="divider" aria-hidden="true"></span>
    <svg class="icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <ellipse cx="6" cy="4" rx="4.5" ry="1.8" stroke="currentColor" stroke-width="1.1"/>
      <path d="M1.5 4v4c0 1 2 1.8 4.5 1.8S10.5 9 10.5 8V4" stroke="currentColor" stroke-width="1.1"/>
    </svg>
    <span class="meta">{schema}</span>
    <span class="divider" aria-hidden="true"></span>
    <svg class="icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.1"/>
      <line x1="6" y1="3" x2="6" y2="6.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
      <circle cx="6" cy="8" r="0.6" fill="currentColor"/>
    </svg>
    <span class="meta version" title={serverVersion}>{shortVersion}</span>
  </div>

  <!-- Right: actions -->
  <div class="bar-right">
    <button
      class="action-btn commit-btn"
      class:enabled={commitState.enabled}
      disabled={!commitState.enabled}
      aria-disabled={commitState.ariaDisabled}
      onclick={onCommit}
      title="Commit pending transaction (F10)"
    >
      ✓ Commit<span class="kbd">F10</span>
    </button>
    <button
      class="action-btn rollback-btn"
      class:enabled={rollbackState.enabled}
      disabled={!rollbackState.enabled}
      aria-disabled={rollbackState.ariaDisabled}
      onclick={onRollback}
      title="Rollback pending transaction (F11)"
    >
      ↺ Rollback<span class="kbd">F11</span>
    </button>
    <span class="bar-divider" aria-hidden="true"></span>
    <button
      class="action-btn ai-btn"
      class:active={chatOpen}
      aria-label="Toggle AI assistant (⌘I)"
      title="Toggle AI assistant (⌘I)"
      onclick={onToggleChat}
    >
      <img src="/veesker-sheep.png" class="ai-btn-sheep" alt="" aria-hidden="true" />
      AI
    </button>
    <button
      class="action-btn sql-btn"
      class:active={sqlEditor.drawerOpen}
      aria-label="Toggle SQL drawer (⌘J)"
      title="Toggle SQL drawer (⌘J)"
      onclick={() => sqlEditor.toggleDrawer()}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M1.5 3.5l3 2.5-3 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="6" y1="8.5" x2="10.5" y2="8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      SQL
    </button>
    <button
      class="action-btn theme-btn"
      class:active={theme === "dark"}
      aria-label="Toggle dark mode"
      aria-pressed={theme === "dark"}
      title="Toggle dark mode"
      onclick={onToggleTheme}
    >
      {#if theme === "dark"}🌙{:else}☀{/if}
    </button>
    <button
      class="action-btn switch-btn"
      aria-label="Switch connection"
      title="Switch connection"
      onclick={onSwitchConnection}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2 4h8M8 2l2 2-2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10 8H2M4 6l-2 2 2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Switch
    </button>
    <button
      class="action-btn disconnect-btn"
      aria-label="Disconnect"
      title="Disconnect"
      onclick={onDisconnect}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M5 2H2a.5.5 0 00-.5.5v7A.5.5 0 002 10h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M8 4l2.5 2L8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="4.5" y1="6" x2="10.5" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
      Disconnect
    </button>
    <div class="cloud-wrap">
      {#if authCtx.tier === "cloud"}
        <button
          class="cloud-btn cloud-btn--account"
          onclick={() => { showCloudMenu = !showCloudMenu; }}
          title="Veesker Cloud account"
        >
          <img src="/veesker-cloud-logo.png" class="cloud-icon" alt="" aria-hidden="true" />
          Cloud
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true" class:chevron-open={showCloudMenu}>
            <path d="M1.5 3l2.5 2 2.5-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if showCloudMenu}
          <div class="cloud-dropdown" role="menu">
            <button class="cloud-dropdown-item" role="menuitem" onclick={() => { showCloudMenu = false; onAuditLog?.(); }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <path d="M3 4h6M3 6h6M3 8h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
              </svg>
              Audit log
            </button>
            <button class="cloud-dropdown-item cloud-dropdown-item--danger" role="menuitem" onclick={() => { showCloudMenu = false; onSignOut?.(); }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M4.5 2H2a.5.5 0 00-.5.5v7A.5.5 0 002 10h2.5M8 4l3 2-3 2M5 6h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Sign out
            </button>
          </div>
          <div class="cloud-dropdown-backdrop" role="presentation" onclick={() => { showCloudMenu = false; }}></div>
        {/if}
      {:else}
        <button
          class="cloud-btn cloud-btn--signin"
          onclick={() => { onSignIn?.(); }}
          title="Sign in to Veesker Cloud"
        >
          <img src="/veesker-cloud-logo.png" class="cloud-icon" alt="" aria-hidden="true" />
          Cloud
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .bar {
    background: #100e0b;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    color: rgba(255,255,255,0.75);
    padding: 0 0.85rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 38px;
    box-sizing: border-box;
    font-family: "Inter", -apple-system, system-ui, sans-serif;
    font-size: 12px;
    flex-shrink: 0;
    position: relative;
  }
  /* Subtle env-tinted top stripe so PROD/STAGING is visible without being noisy */
  .bar.bar-prod::before, .bar.bar-staging::before {
    content: "";
    position: absolute; left: 0; right: 0; top: 0; height: 3px;
    pointer-events: none;
  }
  .bar.bar-prod::before { background: #b33e1f; box-shadow: 0 0 8px rgba(179,62,31,0.5); }
  .bar.bar-staging::before { background: #d99c2a; }
  .bar.bar-prod { box-shadow: inset 0 0 0 1px rgba(179,62,31,0.18); }
  .env-badge {
    display: inline-flex; align-items: center;
    font-family: "Space Grotesk", sans-serif;
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase;
    border-radius: 3px; padding: 1px 6px;
    flex-shrink: 0;
  }
  .env-prod {
    color: #fff;
    background: #b33e1f;
    border: 1px solid #8c2f17;
    animation: prod-pulse 3s ease-in-out infinite;
  }
  @keyframes prod-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.8; }
  }
  .env-staging { color: #e8c547; background: rgba(217,153,42,0.18); border: 1px solid rgba(217,153,42,0.4); }
  .env-dev { color: #4a9eda; background: rgba(74,158,218,0.18); border: 1px solid rgba(74,158,218,0.4); }
  .ro-badge {
    display: inline-flex; align-items: center; gap: 3px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.07em;
    color: rgba(255,255,255,0.8);
    background: rgba(106,110,119,0.22);
    border: 1px solid rgba(106,110,119,0.4);
    border-radius: 3px; padding: 1px 6px;
    flex-shrink: 0;
  }
  /* L1.2 (Sprint C) air-gap badge — solid dark, no animation so it doesn't
     compete with the prod-pulse stripe above. */
  .bar-airgap {
    display: inline-flex; align-items: center; gap: 3px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em;
    color: #f6f1e8;
    background: #14181f;
    border: 1px solid #2a3142;
    border-radius: 3px; padding: 1px 6px;
    flex-shrink: 0;
  }
  /* L2.1 PSDPM badge — medium-emphasis lock indicator. Solid violet so it
     reads against both env-tinted (PROD/STAGING) and neutral status bars. */
  .bar-psdpm {
    display: inline-flex; align-items: center; gap: 3px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.07em;
    color: #fff;
    background: #6d4ae8;
    border: 1px solid #5a39d6;
    border-radius: 3px; padding: 1px 7px;
    flex-shrink: 0;
  }

  /* ── Left cluster ─────────────────────────────────────────── */
  .bar-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
    min-width: 0;
  }
  :global(.bar-mark) {
    flex-shrink: 0;
    opacity: 0.9;
    color: #E85D3C;
  }
  :global([data-tier="cloud"]) :global(.bar-mark) {
    color: #2bb4ee;
    opacity: 1;
  }
  .bar-divider {
    width: 1px;
    height: 14px;
    background: rgba(255,255,255,0.1);
    flex-shrink: 0;
  }
  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #7ec96a;
    box-shadow: 0 0 5px rgba(126,201,106,0.5);
    flex-shrink: 0;
  }
  .conn-name {
    font-family: "Space Grotesk", sans-serif;
    font-weight: 600;
    font-size: 12.5px;
    color: #f6f1e8;
    white-space: nowrap;
  }
  .tx-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    border-radius: 4px;
    padding: 1px 6px;
    flex-shrink: 0;
    animation: tx-pulse 2s ease-in-out infinite;
    color: #e8c547;
    background: rgba(232,197,71,0.12);
    border: 1px solid rgba(232,197,71,0.3);
  }
  .tx-badge-dev {
    color: #e8c547;
    background: rgba(232,197,71,0.12);
    border-color: rgba(232,197,71,0.3);
  }
  .tx-badge-staging {
    color: #ff9933;
    background: rgba(255,153,51,0.14);
    border-color: rgba(255,153,51,0.4);
  }
  .tx-badge-prod {
    color: #ff5252;
    background: rgba(255,82,82,0.16);
    border-color: rgba(255,82,82,0.5);
    animation: tx-pulse-prod 1.4s ease-in-out infinite;
  }
  @keyframes tx-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.65; }
  }
  @keyframes tx-pulse-prod {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .divider {
    width: 1px;
    height: 14px;
    background: rgba(255,255,255,0.12);
    flex-shrink: 0;
    margin: 0 0.1rem;
  }
  .icon {
    color: rgba(255,255,255,0.35);
    flex-shrink: 0;
  }
  .meta {
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 11px;
    color: rgba(255,255,255,0.55);
    white-space: nowrap;
  }
  .version {
    font-size: 10.5px;
    color: rgba(255,255,255,0.35);
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }

  /* ── Right cluster ────────────────────────────────────────── */
  .bar-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 5px;
    color: rgba(255,255,255,0.65);
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.03em;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .action-btn:hover {
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.9);
    border-color: rgba(255,255,255,0.18);
  }
  .ai-btn-sheep {
    width: 14px;
    height: 14px;
    object-fit: contain;
    flex-shrink: 0;
  }
  .ai-btn.active {
    background: rgba(179,62,31,0.25);
    border-color: rgba(179,62,31,0.5);
    color: #f5a08a;
  }
  .ai-btn.active:hover { background: rgba(179,62,31,0.35); }
  .sql-btn.active {
    background: #b33e1f;
    border-color: #b33e1f;
    color: #fff;
  }
  .sql-btn.active:hover { background: #c94b28; }
  .theme-btn.active {
    background: rgba(249, 115, 22, 0.15);
    border-color: rgba(249, 115, 22, 0.4);
    color: #fb923c;
  }
  .theme-btn.active:hover { background: rgba(249, 115, 22, 0.25); }
  .switch-btn:hover {
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.9);
  }
  .disconnect-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(239, 68, 68, 0.4);
    color: #f87171;
  }

  /* ── Cloud tier overrides ─────────────────────────────────── */
  :global([data-tier="cloud"]) .bar {
    background: #0a0e14;
    border-bottom-color: rgba(43, 180, 238, 0.1);
  }
  :global([data-tier="cloud"]) .bar:not(.bar-prod):not(.bar-staging)::before {
    content: "";
    position: absolute; left: 0; right: 0; top: 0; height: 2px;
    pointer-events: none;
    background: linear-gradient(90deg, #1a8bbf 0%, #2bb4ee 50%, #1a8bbf 100%);
    opacity: 0.7;
  }
  :global([data-tier="cloud"]) .conn-name { color: #e6edf3; }
  :global([data-tier="cloud"]) .ai-btn.active {
    background: rgba(43, 180, 238, 0.18);
    border-color: rgba(43, 180, 238, 0.4);
    color: #2bb4ee;
  }
  :global([data-tier="cloud"]) .ai-btn.active:hover {
    background: rgba(43, 180, 238, 0.28);
  }
  :global([data-tier="cloud"]) .sql-btn.active {
    background: #2bb4ee;
    border-color: #2bb4ee;
    color: #fff;
  }
  :global([data-tier="cloud"]) .sql-btn.active:hover { background: #40bdee; }
  :global([data-tier="cloud"]) .theme-btn.active {
    background: rgba(43, 180, 238, 0.15);
    border-color: rgba(43, 180, 238, 0.4);
    color: #2bb4ee;
  }
  :global([data-tier="cloud"]) .theme-btn.active:hover { background: rgba(43, 180, 238, 0.25); }

  /* ── Cloud button ─────────────────────────────────────────── */
  .cloud-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .cloud-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px;
    font-weight: 600;
    padding: 0.25rem 0.6rem;
    border-radius: 5px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    line-height: 1;
    letter-spacing: 0.02em;
  }
  .cloud-btn--account {
    background: rgba(43, 180, 238, 0.18);
    border-color: rgba(43, 180, 238, 0.35);
    color: #2bb4ee;
  }
  .cloud-btn--account:hover {
    background: rgba(43, 180, 238, 0.28);
    border-color: rgba(43, 180, 238, 0.55);
  }
  .cloud-btn--signin {
    background: rgba(43, 180, 238, 0.08);
    border-color: rgba(43, 180, 238, 0.22);
    color: rgba(43, 180, 238, 0.75);
  }
  .cloud-btn--signin:hover {
    background: rgba(43, 180, 238, 0.18);
    border-color: rgba(43, 180, 238, 0.45);
    color: #2bb4ee;
  }
  .cloud-icon {
    width: 13px;
    height: 13px;
    border-radius: 3px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .chevron-open {
    transform: rotate(180deg);
    transition: transform 0.15s;
  }
  .cloud-dropdown {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    background: #1a1e27;
    border: 1px solid rgba(43, 180, 238, 0.25);
    border-radius: 7px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.45);
    padding: 4px;
    z-index: 500;
    min-width: 148px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cloud-dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    font-family: "Space Grotesk", sans-serif;
    font-size: 11.5px;
    font-weight: 500;
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: 5px;
    color: rgba(255,255,255,0.75);
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .cloud-dropdown-item:hover {
    background: rgba(43, 180, 238, 0.12);
    color: #e6edf3;
  }
  .cloud-dropdown-item--danger:hover {
    background: rgba(239, 68, 68, 0.12);
    color: #f87171;
  }
  .cloud-dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: 499;
  }

  .userhost {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    color: #ffb380;
    font-weight: 500;
    white-space: nowrap;
  }
  .action-btn.commit-btn,
  .action-btn.rollback-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 5px;
    color: rgba(255,255,255,0.65);
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px; font-weight: 500;
    letter-spacing: 0.03em;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .commit-btn.enabled {
    background: rgba(126, 201, 106, 0.15);
    border-color: rgba(126, 201, 106, 0.4);
    color: #b6e0a3;
  }
  .commit-btn.enabled:hover {
    background: rgba(126, 201, 106, 0.25);
    border-color: rgba(126, 201, 106, 0.55);
  }
  .rollback-btn.enabled {
    background: rgba(232, 197, 71, 0.12);
    border-color: rgba(232, 197, 71, 0.35);
    color: #e8c547;
  }
  .rollback-btn.enabled:hover {
    background: rgba(232, 197, 71, 0.22);
    border-color: rgba(232, 197, 71, 0.5);
  }
  .action-btn:disabled {
    opacity: 0.32;
    cursor: not-allowed;
  }
  .action-btn .kbd {
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px;
    opacity: 0.55;
    padding-left: 3px;
    border-left: 1px solid rgba(255,255,255,0.15);
    margin-left: 3px;
  }
</style>
