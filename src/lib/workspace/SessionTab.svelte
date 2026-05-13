<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { operationsPanel } from "$lib/stores/operations-panel.svelte";
  import {
    mapSessionError,
    formatLogonAge,
    semanticColorFor,
    type MappedSessionError,
  } from "./session-tab-helpers";

  type SessionSelfRow = {
    sid: number;
    serial: number;
    username: string | null;
    osuser: string | null;
    machine: string | null;
    program: string | null;
    logonTime: string;
    module: string | null;
    action: string | null;
    clientInfo: string | null;
    clientIdentifier: string | null;
    status: string;
    state: string;
    event: string | null;
    sqlId: string | null;
    blockingSession?: number;
    blockingSessionStatus?: string;
  };

  let row = $state<SessionSelfRow | null>(null);
  let error = $state<MappedSessionError | null>(null);
  let loading = $state(false);
  let lastUpdatedAt = $state(0);
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let nowTick = $state(Date.now());
  let refreshEpoch = 0;

  const REFRESH_OPTIONS = [
    { value: 0, label: "Off" },
    { value: 1, label: "1s" },
    { value: 2, label: "2s" },
    { value: 5, label: "5s" },
    { value: 10, label: "10s" },
    { value: 30, label: "30s" },
  ];

  async function refresh() {
    if (loading) return;
    const myEpoch = ++refreshEpoch;
    loading = true;
    try {
      const result = await invoke<SessionSelfRow>("session_self");
      if (myEpoch !== refreshEpoch) return;
      row = result;
      error = null;
      lastUpdatedAt = Date.now();
    } catch (e) {
      if (myEpoch !== refreshEpoch) return;
      error = mapSessionError(e);
    } finally {
      if (myEpoch === refreshEpoch) {
        loading = false;
      }
    }
  }

  $effect(() => {
    void nowTick;
    const isActive = operationsPanel.activeTab === "session" && operationsPanel.isOpen;
    const visible = typeof document !== "undefined" ? !document.hidden : true;
    const sec = operationsPanel.autoRefreshSec;

    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    if (isActive && visible && sec > 0) {
      refresh();
      intervalId = setInterval(refresh, sec * 1000);
    } else if (isActive && row === null && error === null) {
      refresh();
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      refreshEpoch++;
    };
  });

  $effect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      nowTick = Date.now();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  });

  $effect(() => {
    if (lastUpdatedAt === 0) return;
    const i = setInterval(() => { nowTick = Date.now(); }, 1000);
    return () => clearInterval(i);
  });

  function ageOfUpdate(): string {
    if (lastUpdatedAt === 0) return "";
    const sec = Math.floor((nowTick - lastUpdatedAt) / 1000);
    return `updated ${sec}s ago`;
  }
</script>

<div class="session-tab">
  <header class="session-head">
    <button class="refresh-btn" onclick={refresh} disabled={loading}>
      ↻ Refresh
    </button>
    <label class="auto-label">
      Auto:
      <select
        value={operationsPanel.autoRefreshSec}
        onchange={(e) => operationsPanel.setAutoRefresh(Number((e.target as HTMLSelectElement).value))}
        disabled={error?.kind === "missing_privilege"}
      >
        {#each REFRESH_OPTIONS as opt}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>
    {#if operationsPanel.autoRefreshSec > 0}
      <span class="live-chip">
        <span class="live-dot"></span>LIVE {operationsPanel.autoRefreshSec}s
      </span>
    {/if}
  </header>

  {#if error?.kind === "missing_privilege"}
    <div class="empty empty-priv">
      <div class="lock-icon">🔒</div>
      <h3>No SELECT privilege on V$SESSION</h3>
      <p>Ask your DBA to run:</p>
      <code class="grant-block" style="user-select: all">{error.grant}</code>
      <a href="docs/security/vsession-fingerprint.md" target="_blank" rel="noopener">
        V$SESSION fingerprint guide ↗
      </a>
    </div>
  {:else if error?.kind === "transient"}
    <div class="empty empty-transient">
      <p>Couldn't read V$SESSION right now.</p>
      {#if error.oracleCode}<p class="ora">ORA-{String(error.oracleCode).padStart(5, "0")}</p>{/if}
      <button class="retry-btn" onclick={refresh}>Retry</button>
    </div>
  {:else if row === null}
    <div class="empty empty-loading">
      <span class="spinner"></span>
    </div>
  {:else}
    <div class="kv-body">
      <section class="kv-group">
        <h4>Identity</h4>
        <dl>
          <dt>SID</dt>
          <dd style="color: {semanticColorFor('SID', String(row.sid))}">{row.sid}</dd>
          <dt>SERIAL#</dt>
          <dd style="color: {semanticColorFor('SERIAL', String(row.serial))}">{row.serial}</dd>
          <dt>USERNAME</dt>
          <dd>{row.username ?? "—"}</dd>
          <dt>OSUSER</dt>
          <dd>{row.osuser ?? "—"}</dd>
          <dt>MACHINE</dt>
          <dd>{row.machine ?? "—"}</dd>
          <dt>PROGRAM</dt>
          <dd style="color: {semanticColorFor('PROGRAM', row.program ?? '')}">{row.program ?? "—"}</dd>
          <dt>LOGON_TIME</dt>
          <dd title={row.logonTime}>{formatLogonAge(row.logonTime, nowTick)}</dd>
        </dl>
      </section>

      <section class="kv-group">
        <h4>Branding</h4>
        <dl>
          <dt>MODULE</dt>
          <dd style="color: {semanticColorFor('MODULE', row.module ?? '')}">{row.module ?? "—"}</dd>
          <dt>ACTION</dt>
          <dd>{row.action ?? "—"}</dd>
          <dt>CLIENT_INFO</dt>
          <dd>{row.clientInfo ?? "—"}</dd>
          <dt>CLIENT_IDENTIFIER</dt>
          <dd style="color: {semanticColorFor('CLIENT_IDENTIFIER', row.clientIdentifier ?? '')}">{row.clientIdentifier ?? "—"}</dd>
        </dl>
      </section>

      <section class="kv-group">
        <h4>Status</h4>
        <dl>
          <dt>STATUS</dt>
          <dd style="color: {semanticColorFor('STATUS', row.status)}">{row.status}</dd>
          <dt>STATE</dt>
          <dd style="color: {semanticColorFor('STATE', row.state)}">{row.state}</dd>
          <dt>EVENT</dt>
          <dd style="color: {semanticColorFor('EVENT', row.event ?? '')}">{row.event ?? "—"}</dd>
          {#if row.blockingSession !== undefined}
            <dt>BLOCKING_SESSION</dt>
            <dd>{row.blockingSession} ({row.blockingSessionStatus ?? "?"})</dd>
          {/if}
        </dl>
      </section>

      <section class="kv-group">
        <h4>SQL</h4>
        <dl>
          <dt>SQL_ID</dt>
          <dd style="color: {semanticColorFor('SQL_ID', row.sqlId ?? '')}">{row.sqlId ?? "—"}</dd>
        </dl>
      </section>

      {#if operationsPanel.autoRefreshSec > 0 && lastUpdatedAt > 0}
        <footer class="kv-footer">↻ {ageOfUpdate()}</footer>
      {/if}
    </div>
  {/if}
</div>

<style>
  .session-tab { display: flex; flex-direction: column; flex: 1 1 auto; overflow: hidden; }
  .session-head {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vsk-border-subtle, rgba(255,255,255,0.05));
  }
  .refresh-btn, .retry-btn {
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 5px;
    color: var(--vsk-fg-default, rgba(255,255,255,0.65));
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px; font-weight: 500;
    padding: 4px 10px; cursor: pointer;
  }
  .refresh-btn:disabled { opacity: 0.5; cursor: wait; }
  .auto-label {
    font-size: 11px; color: rgba(255,255,255,0.45);
    display: inline-flex; align-items: center; gap: 4px;
  }
  .auto-label select {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.7);
    border-radius: 4px; padding: 2px 4px; font-size: 11px;
  }
  .live-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(255,90,90,0.12);
    color: #ff5a5a; padding: 2px 8px; border-radius: 4px;
    font-family: "JetBrains Mono", monospace; font-size: 10px; font-weight: 700;
  }
  .live-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #ff5a5a; box-shadow: 0 0 4px #ff5a5a;
    animation: live-pulse 1.6s infinite;
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }

  .kv-body { flex: 1; overflow-y: auto; padding: 4px 0; }
  .kv-group { padding: 8px 12px; }
  .kv-group h4 {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9.5px; letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.45);
    margin: 0 0 6px 0;
  }
  dl {
    display: grid; grid-template-columns: 130px 1fr;
    gap: 2px 12px; margin: 0;
  }
  dt {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px; color: rgba(255,255,255,0.4);
    padding: 3px 0;
  }
  dd {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: var(--vsk-fg-default, rgba(255,255,255,0.75));
    margin: 0; padding: 3px 0;
    word-break: break-all;
  }
  dd:nth-of-type(odd) { background: rgba(255,255,255,0.015); }

  .empty {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 32px; gap: 12px; text-align: center;
  }
  .empty-priv .lock-icon { font-size: 32px; opacity: 0.6; }
  .empty-priv h3 { font-size: 13px; color: rgba(255,255,255,0.7); margin: 0; }
  .empty-priv p { font-size: 11px; color: rgba(255,255,255,0.5); margin: 0; }
  .grant-block {
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 4px;
    padding: 8px 12px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: #ffb380;
    cursor: text;
  }
  .empty-priv a {
    font-size: 11px; color: #79c0ff;
    text-decoration: none;
  }
  .empty-priv a:hover { text-decoration: underline; }
  .empty-transient .ora {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: rgba(255,180,160,0.8);
  }
  .spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(255,255,255,0.1);
    border-top-color: #E85D3C;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .kv-footer {
    padding: 6px 12px;
    font-size: 9.5px;
    color: rgba(255,255,255,0.35);
    border-top: 1px solid rgba(255,255,255,0.05);
    text-align: right;
  }
</style>
