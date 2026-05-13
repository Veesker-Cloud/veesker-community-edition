<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
-->

<script lang="ts">
  import type { ConnectionMeta } from "$lib/connections";

  type Props = {
    conn: ConnectionMeta;
    deleting?: boolean;
    onClick?: () => void;
    onEdit?: (e: MouseEvent) => void;
    onDelete?: (e: MouseEvent) => void;
  };
  let { conn, deleting = false, onClick, onEdit, onDelete }: Props = $props();

  function connSubtitle(c: ConnectionMeta): string {
    if (c.authType === "basic") return `${c.host}:${c.port} / ${c.serviceName}`;
    return c.connectAlias;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<li
  class="card"
  class:card-deleting={deleting}
  onclick={() => { if (!deleting) onClick?.(); }}
  onkeydown={(e) => { if (e.key === "Enter" && !deleting) onClick?.(); }}
  tabindex={deleting ? -1 : 0}
  role="button"
  aria-disabled={deleting}
>
  <div class="card-icon" class:wallet={conn.authType === "wallet"}>
    {#if conn.authType === "wallet"}
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="2" y="5" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <path d="M2 9h16" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="14" cy="13" r="1.5" fill="currentColor"/>
        <path d="M5 3l3-1 3 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    {:else}
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <ellipse cx="10" cy="7" rx="7" ry="3" stroke="currentColor" stroke-width="1.5"/>
        <path d="M3 7v6c0 1.7 3.1 3 7 3s7-1.3 7-3V7" stroke="currentColor" stroke-width="1.5"/>
        <path d="M3 10c0 1.7 3.1 3 7 3s7-1.3 7-3" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/>
      </svg>
    {/if}
  </div>
  <div class="card-body">
    <div class="card-name">{conn.name}</div>
    <div class="card-meta">
      <span class="card-user mono">{conn.username}</span>
      <span class="card-sep">·</span>
      <span class="card-host mono">{connSubtitle(conn)}</span>
      {#if conn.authType === "wallet"}
        <span class="badge-wallet">wallet</span>
      {/if}
    </div>
  </div>
  <div class="card-actions" role="none">
    <button
      class="action-btn edit"
      title="Edit"
      aria-label="Edit {conn.name}"
      onclick={(e) => { e.stopPropagation(); onEdit?.(e); }}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <path d="M9 2L11 4L5 10H3V8L9 2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
      </svg>
      Edit
    </button>
    <button
      class="action-btn delete"
      title="Delete"
      aria-label="Delete {conn.name}"
      disabled={deleting}
      onclick={(e) => { e.stopPropagation(); onDelete?.(e); }}
    >
      {#if deleting}
        <span class="action-spinner" aria-label="Deleting"></span>
      {:else}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 3h8M5 3V2h2v1M10 3l-.6 7.5A1 1 0 018.4 11H3.6a1 1 0 01-1-.5L2 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      {/if}
    </button>
    <span class="open-arrow" aria-hidden="true">→</span>
  </div>
</li>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.1rem;
    background: var(--bg-surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 0.12s, box-shadow 0.12s, transform 0.1s;
    user-select: none;
  }
  .card:hover {
    background: var(--row-hover);
    border-color: var(--border-strong);
    box-shadow: 0 2px 10px rgba(26, 22, 18, 0.07);
    transform: translateY(-1px);
  }
  .card:active {
    transform: translateY(0);
    box-shadow: none;
  }
  .card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .card-deleting {
    opacity: 0.55;
    pointer-events: none;
  }
  .card-deleting .action-btn { pointer-events: auto; }
  .action-btn:disabled { opacity: 0.7; cursor: default; }
  .action-spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.65s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .card-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: var(--row-hover);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.12s;
  }
  .card:hover .card-icon {
    background: var(--accent-shadow);
    color: var(--accent);
  }
  .card-icon.wallet {
    background: rgba(142, 68, 173, 0.08);
    color: #8e44ad;
  }
  .card:hover .card-icon.wallet {
    background: rgba(142, 68, 173, 0.14);
    color: #8e44ad;
  }

  .card-body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .card-name {
    font-family: "Space Grotesk", sans-serif;
    font-weight: 500;
    font-size: 15px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 11.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
  }
  .mono { font-family: "JetBrains Mono", "SF Mono", monospace; }
  .card-sep { opacity: 0.4; }
  .card-host {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge-wallet {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    background: rgba(142, 68, 173, 0.1);
    color: #8e44ad;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
  }
  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.3rem 0.55rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    color: var(--text-secondary);
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .action-btn.edit:hover {
    background: var(--row-hover);
    color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .action-btn.delete {
    border-color: transparent;
    padding: 0.3rem 0.4rem;
  }
  .action-btn.delete:hover {
    background: rgba(239, 68, 68, 0.08);
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.2);
  }
  .open-arrow {
    font-size: 15px;
    color: var(--text-muted);
    margin-left: 0.25rem;
    transition: color 0.12s, transform 0.12s;
    line-height: 1;
  }
  .card:hover .open-arrow {
    color: var(--accent);
    transform: translateX(2px);
  }
</style>
