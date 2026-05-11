<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { operationsPanel } from "$lib/stores/operations-panel.svelte";
  import {
    mapSessionError,
    formatLogonAge,
    semanticColorFor,
    type MappedSessionError,
  } from "./session-tab-helpers";
  import { sessionsListAllGet, sessionPrivCheckGet, sessionKillRpc, blockingChainGet, type SessionRow, type BlockingPair } from "$lib/workspace";

  type Props = { connectionEnv?: string };
  let { connectionEnv = "" }: Props = $props();

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

  let allSessionsMode = $state(false);
  let allSessions = $state<SessionRow[]>([]);
  let allSessionsLoading = $state(false);
  let allSessionsAccessDenied = $state(false);
  let allSessionsError = $state<string | null>(null);
  let hasAlterSystem = $state(false);
  let currentSid = $state<number | null>(null);

  $effect(() => { if (row) currentSid = row.sid; });

  async function refreshAllSessions() {
    if (!allSessionsMode || allSessionsLoading) return;
    allSessionsLoading = true;
    allSessionsError = null;
    try {
      const [sessRes, privRes] = await Promise.all([
        sessionsListAllGet(),
        sessionPrivCheckGet(),
      ]);
      if (sessRes.ok) {
        allSessions = sessRes.data.sessions;
        allSessionsAccessDenied = sessRes.data.accessDenied;
      } else {
        allSessionsError = sessRes.error.message;
      }
      if (privRes.ok) hasAlterSystem = privRes.data.hasAlterSystem;
    } finally {
      allSessionsLoading = false;
    }
    void refreshBlockingChain();
  }

  let killTarget = $state<SessionRow | null>(null);
  let killRunning = $state(false);
  let killError = $state<string | null>(null);
  let killProdConfirmed = $state(false);

  function confirmKill(s: SessionRow) {
    killTarget = s;
    killError = null;
    killProdConfirmed = false;
  }

  function cancelKill() {
    killTarget = null;
    killError = null;
    killProdConfirmed = false;
  }

  let blockingPairs = $state<BlockingPair[]>([]);
  let blockingLoading = $state(false);
  let blockingAccessDenied = $state(false);

  async function refreshBlockingChain() {
    blockingLoading = true;
    try {
      const res = await blockingChainGet();
      if (res.ok) {
        blockingPairs = res.data.pairs;
        blockingAccessDenied = res.data.accessDenied;
      }
    } finally {
      blockingLoading = false;
    }
  }

  $effect(() => { if (allSessionsMode) void refreshBlockingChain(); });

  async function executeKill(isProd: boolean) {
    if (!killTarget || killRunning) return;
    killRunning = true;
    killError = null;
    try {
      const res = await sessionKillRpc(killTarget.sid, killTarget.serial, isProd ? true : undefined);
      if (res.ok) {
        allSessions = allSessions.filter((s) => s.sid !== killTarget!.sid || s.serial !== killTarget!.serial);
        killTarget = null;
      } else {
        killError = res.error.message;
      }
    } finally {
      killRunning = false;
    }
  }

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
      if (allSessionsMode) void refreshAllSessions();
      intervalId = setInterval(() => { refresh(); if (allSessionsMode) void refreshAllSessions(); }, sec * 1000);
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
  <div class="session-mode-toggle">
    <button class:active={!allSessionsMode} onclick={() => { allSessionsMode = false; }}>My Session</button>
    <button class:active={allSessionsMode} onclick={() => { allSessionsMode = true; void refreshAllSessions(); }}>All Sessions</button>
  </div>
  {#if !allSessionsMode}
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
  {:else}
  {#if allSessionsAccessDenied}
    <div class="all-sessions-denied">
      V$SESSION access required — grant <code>SELECT ON V_$SESSION</code> or <code>SELECT ANY DICTIONARY</code> to this user
    </div>
  {:else if allSessionsError}
    <div class="all-sessions-denied">{allSessionsError}</div>
  {:else}
    <div class="all-sessions-header">
      <span class="session-count">{allSessions.length} sessions</span>
      <button onclick={() => void refreshAllSessions()} class="refresh-btn" disabled={allSessionsLoading}>↻ Refresh</button>
    </div>
    {#if allSessionsLoading && allSessions.length === 0}
      <div class="empty empty-loading"><span class="spinner"></span></div>
    {:else}
      <div class="all-sessions-scroll">
        <table class="sessions-table">
          <thead>
            <tr>
              <th>SID</th>
              <th>Username</th>
              <th>Status</th>
              <th>Machine</th>
              <th>Wait Event</th>
              <th>Idle (s)</th>
              <th>SQL ID</th>
              {#if hasAlterSystem}<th></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each allSessions as s}
              <tr class="session-row session-status-{s.status.toLowerCase()}">
                <td class="sid-col">{s.sid}</td>
                <td>{s.username ?? "—"}</td>
                <td><span class="status-chip-sm status-{s.status.toLowerCase()}">{s.status}</span></td>
                <td class="truncate" title={s.machine ?? ""}>{s.machine ?? "—"}</td>
                <td class="truncate" title={s.event ?? ""}>{s.waitClass === "Idle" ? "—" : (s.event ?? "—")}</td>
                <td>{s.lastCallEt ?? "—"}</td>
                <td class="sql-col">{s.sqlId ?? "—"}</td>
                {#if hasAlterSystem}
                  <td>
                    {#if s.sid !== currentSid}
                      <button class="kill-btn" onclick={() => confirmKill(s)} title="Kill session">✕</button>
                    {/if}
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if !blockingAccessDenied && blockingPairs.length > 0}
        <div class="blocking-section">
          <div class="blocking-header">
            <span class="blocking-badge">⚠ Blocking ({blockingPairs.length})</span>
          </div>
          {#each Object.entries(blockingPairs.reduce<Record<string, BlockingPair[]>>((acc, p) => {
            const key = String(p.blockerSid);
            acc[key] ??= [];
            acc[key].push(p);
            return acc;
          }, {})) as [blockerSid, waiters]}
            <div class="blocking-group">
              <div class="blocker-row">
                <span class="blocker-label">BLOCKER</span>
                <span class="blocker-sid">SID {blockerSid}</span>
                <span class="blocker-user">{waiters[0].blockerUser ?? "—"}</span>
                <span class="blocker-status status-chip-sm status-{(waiters[0].blockerStatus ?? '').toLowerCase()}">{waiters[0].blockerStatus ?? "?"}</span>
              </div>
              {#each waiters as w}
                <div class="waiter-row">
                  <span class="waiter-indent">└</span>
                  <span class="waiter-sid">SID {w.blockedSid}</span>
                  <span class="waiter-user">{w.blockedUser ?? "—"}</span>
                  <span class="waiter-wait">{w.event ?? "—"}</span>
                  {#if w.secondsInWait != null}
                    <span class="waiter-secs">{w.secondsInWait}s</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
  {/if}
</div>

{#if killTarget}
  <div class="kill-overlay" role="dialog" aria-modal="true" aria-labelledby="kill-dialog-title">
    <div class="kill-dialog">
      <h3 id="kill-dialog-title">Kill Session</h3>
      <p class="kill-detail">
        SID <strong>{killTarget.sid}</strong>, SERIAL# <strong>{killTarget.serial}</strong>
        {#if killTarget.username} — <em>{killTarget.username}</em>{/if}
      </p>
      {#if connectionEnv === "prod"}
        <div class="kill-prod-warning">
          <strong>PRODUCTION environment.</strong> This will immediately terminate the session.
        </div>
        <label class="kill-prod-check">
          <input type="checkbox" bind:checked={killProdConfirmed} />
          I confirm this kill in production
        </label>
      {:else}
        <p class="kill-confirm-text">This will immediately terminate the session (IMMEDIATE mode).</p>
      {/if}
      {#if killError}
        <p class="kill-error">{killError}</p>
      {/if}
      <div class="kill-actions">
        <button class="kill-cancel-btn" onclick={cancelKill} disabled={killRunning}>Cancel</button>
        <button
          class="kill-confirm-btn"
          onclick={() => executeKill(connectionEnv === "prod")}
          disabled={killRunning || (connectionEnv === "prod" && !killProdConfirmed)}
        >
          {killRunning ? "Killing…" : "Kill Session"}
        </button>
      </div>
    </div>
  </div>
{/if}

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
  .session-mode-toggle { display: flex; gap: 0; padding: 8px 12px 0; }
  .session-mode-toggle button { padding: 4px 12px; font-size: 12px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.45); border: 1px solid rgba(255,255,255,0.1); cursor: pointer; font-family: "Space Grotesk", sans-serif; }
  .session-mode-toggle button:first-child { border-radius: 4px 0 0 4px; }
  .session-mode-toggle button:last-child { border-radius: 0 4px 4px 0; border-left: none; }
  .session-mode-toggle button.active { background: rgba(74,158,218,0.15); color: rgba(255,255,255,0.85); border-color: rgba(74,158,218,0.35); }
  .all-sessions-denied { padding: 16px 12px; font-size: 12px; color: rgba(255,200,100,0.8); background: rgba(255,200,0,0.05); border: 1px solid rgba(255,200,0,0.15); margin: 8px 12px; border-radius: 4px; }
  .all-sessions-denied code { font-family: "JetBrains Mono", monospace; font-size: 11px; }
  .all-sessions-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px 4px; }
  .session-count { font-size: 12px; color: rgba(255,255,255,0.45); }
  .all-sessions-scroll { flex: 1; overflow-y: auto; }
  .sessions-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .sessions-table th { text-align: left; padding: 4px 8px; color: rgba(255,255,255,0.4); border-bottom: 1px solid rgba(255,255,255,0.07); font-family: "Space Grotesk", sans-serif; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
  .sessions-table td { padding: 3px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); color: rgba(255,255,255,0.75); font-family: "JetBrains Mono", monospace; }
  .sessions-table .truncate { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sessions-table .sid-col { color: rgba(255,255,255,0.45); }
  .sessions-table .sql-col { color: rgba(255,180,80,0.75); }
  .status-chip-sm { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; }
  .status-active { background: rgba(39,174,96,0.2); color: hsl(140 60% 70%); }
  .status-inactive { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.45); }
  .kill-btn { background: none; border: none; color: rgba(232,93,60,0.6); cursor: pointer; font-size: 11px; padding: 2px 4px; }
  .kill-btn:hover { color: rgba(232,93,60,0.9); }

  .blocking-section {
    border-top: 1px solid rgba(255,200,80,0.15);
    background: rgba(255,180,0,0.03);
    padding: 6px 12px 8px;
  }
  .blocking-header { margin-bottom: 6px; }
  .blocking-badge {
    font-family: "Space Grotesk", sans-serif;
    font-size: 10px; font-weight: 700;
    color: #e0a030;
    letter-spacing: 0.06em;
  }
  .blocking-group { margin-bottom: 8px; }
  .blocker-row {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 0;
  }
  .blocker-label {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9px; font-weight: 700;
    color: #e0a030; letter-spacing: 0.1em;
    min-width: 48px;
  }
  .blocker-sid, .waiter-sid {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: rgba(255,255,255,0.7);
    min-width: 56px;
  }
  .blocker-user, .waiter-user {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: rgba(255,255,255,0.5);
    min-width: 80px;
  }
  .blocker-status { font-size: 9px; }
  .waiter-row {
    display: flex; align-items: center; gap: 8px;
    padding: 2px 0 2px 4px;
  }
  .waiter-indent {
    color: rgba(255,255,255,0.25);
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; min-width: 12px;
  }
  .waiter-wait {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px; color: rgba(232,93,60,0.7);
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .waiter-secs {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px; color: rgba(255,150,80,0.8);
    min-width: 32px; text-align: right;
  }

  .kill-overlay {
    position: absolute; inset: 0;
    background: rgba(0,0,0,0.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 50;
  }
  .kill-dialog {
    background: #1a1714;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    padding: 20px;
    width: 260px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .kill-dialog h3 {
    margin: 0;
    font-family: "Space Grotesk", sans-serif;
    font-size: 13px; font-weight: 600;
    color: rgba(255,255,255,0.85);
  }
  .kill-detail {
    margin: 0;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px; color: rgba(255,255,255,0.6);
  }
  .kill-confirm-text {
    margin: 0;
    font-size: 11px; color: rgba(255,255,255,0.5);
  }
  .kill-prod-warning {
    background: rgba(232,93,60,0.1);
    border: 1px solid rgba(232,93,60,0.3);
    border-radius: 4px;
    padding: 8px 10px;
    font-size: 11px; color: #E85D3C;
  }
  .kill-prod-check {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; color: rgba(255,255,255,0.65);
    cursor: pointer;
  }
  .kill-error {
    margin: 0;
    font-size: 11px; color: #ff7070;
    background: rgba(255,80,80,0.08);
    border: 1px solid rgba(255,80,80,0.2);
    border-radius: 4px; padding: 6px 8px;
  }
  .kill-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
  }
  .kill-cancel-btn {
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    color: rgba(255,255,255,0.6);
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px; font-weight: 500;
    padding: 5px 12px; cursor: pointer;
  }
  .kill-cancel-btn:hover { background: rgba(255,255,255,0.11); }
  .kill-cancel-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .kill-confirm-btn {
    background: rgba(232,93,60,0.15);
    border: 1px solid rgba(232,93,60,0.4);
    border-radius: 5px;
    color: #E85D3C;
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px; font-weight: 600;
    padding: 5px 12px; cursor: pointer;
  }
  .kill-confirm-btn:hover:not(:disabled) { background: rgba(232,93,60,0.25); }
  .kill-confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
