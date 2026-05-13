<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount, getContext } from "svelte";
  import { page } from "$app/state";
  import {
    listConnections,
    deleteConnection,
    type ConnectionMeta,
  } from "$lib/connections";
  import { logout } from "$lib/services/auth";
  import { sandboxes } from "$lib/stores/sandboxes.svelte";
  import type { SandboxSummary } from "$lib/sandbox";
  import LoginModal from "$lib/workspace/LoginModal.svelte";
  import AuditLogPanel from "$lib/workspace/AuditLogPanel.svelte";
  import OracleConnCard from "$lib/workspace/OracleConnCard.svelte";
  import SandboxCard from "$lib/workspace/SandboxCard.svelte";

  const authCtx = getContext<{ tier: "ce" | "cloud"; email: string }>("auth");

  type ListItem =
    | { kind: "oracle"; conn: ConnectionMeta }
    | { kind: "sandbox"; sb: SandboxSummary };

  let connections = $state<ConnectionMeta[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let deletingId = $state<string | null>(null);
  let confirmTarget = $state<ConnectionMeta | null>(null);
  let confirmInput = $state("");
  let deleteError = $state<string | null>(null);
  let query = $state("");
  let authFilter = $state<"all" | "basic" | "wallet">("all");
  let typeFilter = $state<"all" | "oracle" | "sandbox">("all");
  let showLogin = $state(false);
  let showAccountMenu = $state(false);
  let showAuditLog = $state(false);

  $effect(() => {
    const qp = page.url.searchParams.get("type");
    if (qp === "sandbox" || qp === "oracle" || qp === "all") {
      typeFilter = qp;
    }
  });

  function matchesOracleFilter(c: ConnectionMeta): boolean {
    const q = query.trim().toLowerCase();
    if (authFilter !== "all" && c.authType !== authFilter) return false;
    if (!q) return true;
    const haystack = c.authType === "basic"
      ? `${c.name} ${c.username} ${c.host} ${c.serviceName}`
      : `${c.name} ${c.username} ${c.connectAlias}`;
    return haystack.toLowerCase().includes(q);
  }

  function matchesSandboxFilter(s: SandboxSummary): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${s.name} ${s.owner_user_id}`.toLowerCase().includes(q);
  }

  const items = $derived.by<ListItem[]>(() => {
    const oracle = typeFilter === "sandbox"
      ? []
      : connections
          .filter(matchesOracleFilter)
          .map((c) => ({ kind: "oracle" as const, conn: c }));
    const sb = (typeFilter === "oracle" || authCtx.tier !== "cloud")
      ? []
      : sandboxes.all
          .filter(matchesSandboxFilter)
          .map((s) => ({ kind: "sandbox" as const, sb: s }));
    return [...oracle, ...sb].sort((a, b) => {
      const an = a.kind === "oracle" ? a.conn.name : a.sb.name;
      const bn = b.kind === "oracle" ? b.conn.name : b.sb.name;
      return an.localeCompare(bn);
    });
  });

  const totalCount = $derived(
    connections.length + (authCtx.tier === "cloud" ? sandboxes.all.length : 0),
  );

  async function refresh() {
    loading = true;
    const res = await listConnections();
    if (res.ok) {
      connections = res.data;
      error = null;
    } else {
      error = res.error.message;
    }
    loading = false;
  }

  onMount(async () => {
    await Promise.all([
      refresh(),
      authCtx.tier === "cloud" ? sandboxes.load() : Promise.resolve(),
    ]);
  });

  // Plan 8 focus-refresh, ported from the old /sandboxes route after Plan 12
  // unified everything onto /. Without this, the home page wouldn't re-fetch
  // sandboxes when the user comes back from the workspace tab or after Vite
  // HMR clears module state. 30s debounce avoids hammering on repeated focus.
  const SANDBOX_REFRESH_DEBOUNCE_MS = 30_000;
  let lastSandboxRefreshAt = 0;
  $effect(() => {
    if (authCtx.tier !== "cloud") return;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastSandboxRefreshAt < SANDBOX_REFRESH_DEBOUNCE_MS) return;
      lastSandboxRefreshAt = now;
      void sandboxes.load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  async function handleLogout() {
    await logout();
    authCtx.tier = "ce";
    authCtx.email = "";
  }

  function onDelete(e: MouseEvent, c: ConnectionMeta) {
    e.stopPropagation();
    if (deletingId) return;
    confirmTarget = c;
    confirmInput = "";
    deleteError = null;
  }

  function cancelDelete() {
    confirmTarget = null;
    confirmInput = "";
    deleteError = null;
  }

  async function republishSandboxAction(id: string) {
    try {
      const { sandboxId } = sandboxes.republish(id);
      await goto(`/sandboxes/publish?republishId=${encodeURIComponent(sandboxId)}`);
    } catch (e) {
      sandboxes.error = (e as Error).message ?? String(e);
    }
  }

  async function confirmDelete() {
    if (!confirmTarget || confirmInput !== confirmTarget.name) return;
    deletingId = confirmTarget.id;
    const target = confirmTarget;
    confirmTarget = null;
    confirmInput = "";
    try {
      const res = await deleteConnection(target.id);
      if (!res.ok) {
        deleteError = res.error.message;
        return;
      }
      await refresh();
    } finally {
      deletingId = null;
    }
  }
</script>

<main>
  <img
    src={authCtx.tier === "cloud" ? "/veesker-cloud-logo.png" : "/ce-logo.png"}
    class="home-watermark" alt="" aria-hidden="true"
  />
  <header>
    <div class="brand">
      <img
        src="/veesker-banner.png"
        class="brand-banner"
        alt={authCtx.tier === "cloud" ? "Veesker Cloud" : "Veesker CE"}
      />
      {#if authCtx.tier === "cloud"}
        <p class="tagline tagline-cloud">Cloud</p>
      {:else}
        <p class="tagline">Community Edition</p>
      {/if}
    </div>
    <div class="header-actions">
      {#if authCtx.tier === "cloud"}
        <div class="cloud-menu-wrap">
          <button
            class="cloud-badge-btn"
            onclick={() => { showAccountMenu = !showAccountMenu; }}
            aria-expanded={showAccountMenu}
            aria-haspopup="true"
          >
            <img src="/veesker-cloud-logo.png" class="cloud-btn-icon" alt="" aria-hidden="true" />
            <span class="cloud-account-email">{authCtx.email || "Cloud"}</span>
            <svg class="chevron" class:open={showAccountMenu} width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          {#if showAccountMenu}
            <div class="account-dropdown" role="menu">
              <button
                class="dropdown-item"
                role="menuitem"
                onclick={() => { showAccountMenu = false; showAuditLog = true; }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <rect x="1" y="1.5" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                  <path d="M3.5 4.5h6M3.5 6.5h6M3.5 8.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                </svg>
                Audit log
              </button>
              <a
                class="dropdown-item"
                href="https://billing.stripe.com/p/login/test_00g4j60Av0c89TieUU"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                onclick={() => { showAccountMenu = false; }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                  <path d="M1 6h11" stroke="currentColor" stroke-width="1.3"/>
                </svg>
                Manage billing
              </a>
              <button
                class="dropdown-item dropdown-item--danger"
                role="menuitem"
                onclick={() => { showAccountMenu = false; handleLogout(); }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <path d="M5 2H2a1 1 0 00-1 1v7a1 1 0 001 1h3M9 9l3-2.5L9 4M4 6.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Sign out
              </button>
            </div>
            <div class="dropdown-backdrop" role="presentation" onclick={() => { showAccountMenu = false; }}></div>
          {/if}
        </div>
      {:else}
        <button class="cloud-signin" onclick={() => { showLogin = true; }}>
          <img src="/veesker-cloud-logo.png" class="cloud-btn-icon" alt="" aria-hidden="true" />
          Sign in to Cloud
        </button>
      {/if}
      {#if authCtx.tier === "cloud"}
        <button class="new-btn" onclick={() => goto("/sandboxes/publish")}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          Publish sandbox
        </button>
      {/if}
      <button class="new-btn" onclick={() => goto("/connections/new")}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        New connection
      </button>
    </div>
  </header>

  {#if authCtx.tier === "cloud" && sandboxes.newCount > 0}
    <div class="banner-info banner-new">
      <span><strong>{sandboxes.newCount}</strong> new sandbox{sandboxes.newCount === 1 ? "" : "es"} shared with you</span>
      <button type="button" onclick={() => void sandboxes.markAllSeen()}>Mark all as seen</button>
    </div>
  {/if}

  {#if !loading && !error && totalCount > 0}
    <div class="filter-bar">
      <div class="search-wrap">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.4"/>
          <path d="M9.2 9.2l3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <input
          type="search"
          class="search-input"
          placeholder="Filter by name, user, host…"
          bind:value={query}
          autocomplete="off"
          spellcheck={false}
        />
        {#if query}
          <button
            class="clear-btn"
            title="Clear"
            aria-label="Clear search"
            onclick={() => { query = ""; }}
          >×</button>
        {/if}
      </div>
      <div class="auth-filter" role="tablist" aria-label="Type filter">
        <button class="chip" class:chip-on={typeFilter === "all"}    role="tab" aria-selected={typeFilter === "all"}    onclick={() => typeFilter = "all"}>All</button>
        <button class="chip" class:chip-on={typeFilter === "oracle"} role="tab" aria-selected={typeFilter === "oracle"} onclick={() => typeFilter = "oracle"}>Oracle</button>
        {#if authCtx.tier === "cloud"}
          <button class="chip" class:chip-on={typeFilter === "sandbox"} role="tab" aria-selected={typeFilter === "sandbox"} onclick={() => typeFilter = "sandbox"}>Sandboxes</button>
        {/if}
      </div>
      {#if typeFilter !== "sandbox"}
        <div class="auth-filter" role="tablist" aria-label="Auth type filter">
          <button class="chip" class:chip-on={authFilter === "all"}    role="tab" aria-selected={authFilter === "all"}    onclick={() => authFilter = "all"}>All</button>
          <button class="chip" class:chip-on={authFilter === "basic"}  role="tab" aria-selected={authFilter === "basic"}  onclick={() => authFilter = "basic"}>Basic</button>
          <button class="chip" class:chip-on={authFilter === "wallet"} role="tab" aria-selected={authFilter === "wallet"} onclick={() => authFilter = "wallet"}>Wallet</button>
        </div>
      {/if}
    </div>
  {/if}

  <div class="section-label">
    {#if !loading && !error}
      {#if totalCount === 0}
        No connections or sandboxes
      {:else if items.length === totalCount}
        {totalCount} item{totalCount === 1 ? "" : "s"}
      {:else}
        {items.length} of {totalCount}
      {/if}
    {:else if loading}
      &nbsp;
    {:else}
      &nbsp;
    {/if}
  </div>

  {#if loading}
    <div class="loading-row">
      <span class="spinner"></span>
      <span class="muted">Loading…</span>
    </div>
  {:else if error}
    <div class="alert">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
        <line x1="8" y1="5" x2="8" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="8" cy="11.5" r="0.75" fill="currentColor"/>
      </svg>
      <span>{error}</span>
    </div>
  {:else if totalCount === 0}
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="14" rx="14" ry="6" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
          <path d="M6 14v12c0 3.3 6.3 6 14 6s14-2.7 14-6V14" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
          <line x1="20" y1="22" x2="20" y2="30" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
          <line x1="16" y1="26" x2="24" y2="26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
        </svg>
      </div>
      <p class="empty-title">No connections yet</p>
      <p class="empty-sub">Add your first Oracle database connection to get started.</p>
      <button class="new-btn" onclick={() => goto("/connections/new")}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        New connection
      </button>
    </div>
  {:else if items.length === 0}
    <div class="empty-filter">
      <span class="muted">Nothing matches the current filter.</span>
      <button class="link-btn" onclick={() => { query = ""; authFilter = "all"; typeFilter = "all"; }}>Clear filters</button>
    </div>
  {:else}
    <ul class="list" role="list">
      {#each items as item (item.kind === "oracle" ? `c:${item.conn.id}` : `s:${item.sb.sandbox_id}`)}
        {#if item.kind === "oracle"}
          <OracleConnCard
            conn={item.conn}
            deleting={deletingId === item.conn.id}
            onClick={() => goto(`/workspace/${item.conn.id}`)}
            onEdit={() => goto(`/connections/${item.conn.id}/edit`)}
            onDelete={(e) => onDelete(e, item.conn)}
          />
        {:else}
          <li class="sandbox-li">
            <SandboxCard
              sandbox={item.sb}
              isPulling={sandboxes.pulling.has(item.sb.sandbox_id)}
              isDeleting={false}
              isLeaving={false}
              isNew={!item.sb.cached && !sandboxes.lastSeenIds.has(item.sb.sandbox_id)}
              isStaleVersion={sandboxes.staleVersionIds.has(item.sb.sandbox_id)}
              onOpen={() => goto(`/workspace/${item.sb.sandbox_id}`)}
              onPull={() => sandboxes.pull(item.sb.sandbox_id)}
              onDelete={() => sandboxes.delete(item.sb.sandbox_id)}
              onLeave={() => sandboxes.leave(item.sb.sandbox_id)}
              onRepublish={item.sb.status === "ready"
                ? () => void republishSandboxAction(item.sb.sandbox_id)
                : undefined}
            />
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
</main>

{#if confirmTarget}
  <div class="modal-backdrop" role="presentation" onclick={cancelDelete}>
    <div class="del-modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <div class="del-modal-header">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path d="M9 2L16 15H2L9 2Z" stroke="#e74c3c" stroke-width="1.5" stroke-linejoin="round"/>
          <line x1="9" y1="7" x2="9" y2="11" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="9" cy="13.5" r="0.75" fill="#e74c3c"/>
        </svg>
        <span>Delete connection</span>
      </div>
      <p class="del-modal-body">
        This will permanently delete <strong>{confirmTarget.name}</strong> and remove
        all stored credentials. This action cannot be undone.
      </p>
      <p class="del-modal-label">
        Type <code>{confirmTarget.name}</code> to confirm:
      </p>
      <input
        class="del-modal-input"
        type="text"
        placeholder={confirmTarget.name}
        bind:value={confirmInput}
        onkeydown={(e) => { if (e.key === "Enter") confirmDelete(); if (e.key === "Escape") cancelDelete(); }}
        autofocus
      />
      {#if deleteError}
        <p class="del-modal-err">{deleteError}</p>
      {/if}
      <div class="del-modal-actions">
        <button class="del-btn-cancel" onclick={cancelDelete}>Cancel</button>
        <button
          class="del-btn-confirm"
          disabled={confirmInput !== confirmTarget.name}
          onclick={confirmDelete}
        >Delete connection</button>
      </div>
    </div>
  </div>
{/if}

{#if showAuditLog}
  <AuditLogPanel onClose={() => { showAuditLog = false; }} />
{/if}

{#if showLogin}
  <LoginModal onClose={async () => {
    showLogin = false;
    const { invoke: inv } = await import("@tauri-apps/api/core");
    const token = await inv<string | null>("auth_token_get");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        authCtx.tier = "cloud";
        authCtx.email = payload.email ?? "";
        await sandboxes.load();
      } catch { /* ignore */ }
    }
  }} />
{/if}

<style>
  :global(body) {
    margin: 0;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: "Inter", -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }


  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 3rem 2rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 0;
    position: relative;
  }
  .home-watermark {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 200px;
    height: 200px;
    object-fit: contain;
    opacity: 0.07;
    pointer-events: none;
    user-select: none;
    z-index: 0;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    flex-wrap: wrap;
    row-gap: 0.75rem;
    margin-bottom: 2.5rem;
  }
  .brand {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }
  .brand-banner {
    height: 80px;
    width: auto;
    display: block;
    object-fit: contain;
  }
  .tagline {
    font-family: "Space Grotesk", sans-serif;
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .new-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: var(--text-primary);
    color: var(--bg-surface);
    border: none;
    border-radius: 8px;
    padding: 0.65rem 1.1rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .new-btn:hover { background: var(--accent); }

  .cloud-btn-icon {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .cloud-signin {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: rgba(43, 180, 238, 0.1);
    color: #2bb4ee;
    border: 1px solid rgba(43, 180, 238, 0.3);
    border-radius: 8px;
    padding: 0.6rem 1rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
  }
  .cloud-signin:hover {
    background: rgba(43, 180, 238, 0.18);
    border-color: rgba(43, 180, 238, 0.5);
  }

  .cloud-menu-wrap {
    position: relative;
  }
  .cloud-badge-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: rgba(43, 180, 238, 0.1);
    color: #2bb4ee;
    border: 1px solid rgba(43, 180, 238, 0.3);
    border-radius: 8px;
    padding: 0.55rem 0.8rem 0.55rem 0.6rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
  }
  .cloud-badge-btn:hover {
    background: rgba(43, 180, 238, 0.18);
    border-color: rgba(43, 180, 238, 0.5);
  }
  .cloud-account-email {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chevron {
    color: rgba(43, 180, 238, 0.6);
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .chevron.open { transform: rotate(180deg); }

  .account-dropdown {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 180px;
    background: var(--bg-surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    padding: 4px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    border-radius: 7px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    background: transparent;
    border: none;
    cursor: pointer;
    text-decoration: none;
    transition: background 0.1s;
    width: 100%;
    text-align: left;
  }
  .dropdown-item:hover { background: var(--row-hover); }
  .dropdown-item--danger { color: #ef4444; }
  .dropdown-item--danger:hover { background: rgba(239, 68, 68, 0.08); }

  .dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  .tagline-cloud {
    color: #2bb4ee !important;
    font-weight: 600;
  }

  .filter-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .search-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 220px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0 0.75rem;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .search-wrap:focus-within {
    border-color: var(--accent-border-focus);
    box-shadow: 0 0 0 3px var(--accent-shadow);
  }
  .search-icon { color: var(--text-muted); flex-shrink: 0; }
  .search-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 13px;
    padding: 0.55rem 0;
    font-family: inherit;
  }
  .search-input::placeholder { color: var(--text-muted); }
  .clear-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
    border-radius: 3px;
  }
  .clear-btn:hover { color: var(--text-primary); }
  .auth-filter { display: flex; gap: 4px; flex-shrink: 0; }
  .chip {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0.4rem 0.7rem;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
    font-family: inherit;
  }
  .chip:hover { color: var(--text-primary); border-color: var(--text-muted); }
  .chip-on {
    background: var(--accent-muted);
    border-color: var(--accent-border-focus);
    color: var(--accent);
  }
  .empty-filter {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 0;
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    text-decoration: underline;
    font-family: inherit;
    padding: 0;
  }
  .link-btn:hover { opacity: 0.8; }

  .banner-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: rgba(59, 130, 246, 0.12);
    color: var(--text-primary);
    border-left: 3px solid var(--accent, #3b82f6);
    padding: 0.65rem 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
    font-size: 13px;
    flex-wrap: wrap;
  }
  .banner-info button {
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 4px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }

  .section-label {
    font-family: "Space Grotesk", sans-serif;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 0.6rem;
  }

  .loading-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 1.5rem 0;
  }
  .spinner {
    width: 14px; height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--text-primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .muted { color: var(--text-secondary); font-size: 13px; }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: rgba(239, 68, 68, 0.07);
    color: #b91c1c;
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    font-size: 13px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.6rem;
    padding: 4rem 2rem;
    color: var(--text-secondary);
  }
  .empty-icon {
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }
  .empty-title {
    font-family: "Space Grotesk", sans-serif;
    font-size: 16px;
    font-weight: 500;
    color: var(--text-primary);
    margin: 0;
  }
  .empty-sub {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
    max-width: 280px;
    line-height: 1.5;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .sandbox-li {
    list-style: none;
  }

  .modal-backdrop {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(0, 0, 0, 0.6);
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(2px);
  }
  .del-modal {
    background: var(--bg-surface-raised);
    border: 1px solid #5a1a1a;
    border-radius: 12px;
    padding: 1.5rem;
    width: 420px;
    max-width: 90vw;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .del-modal-header {
    display: flex; align-items: center; gap: 0.6rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 15px; font-weight: 600;
    color: var(--text-primary);
  }
  .del-modal-body {
    font-size: 13px; color: var(--text-secondary);
    line-height: 1.55; margin: 0;
  }
  .del-modal-body strong { color: var(--text-primary); }
  .del-modal-label {
    font-size: 12px; color: var(--text-muted); margin: 0;
  }
  .del-modal-label code {
    font-family: "JetBrains Mono", monospace;
    font-size: 11.5px; color: #e74c3c;
    background: rgba(231, 76, 60, 0.1);
    padding: 1px 5px; border-radius: 3px;
  }
  .del-modal-input {
    background: var(--bg-surface); border: 1px solid var(--border);
    color: var(--text-primary); font-family: "JetBrains Mono", monospace;
    font-size: 13px; padding: 0.55rem 0.75rem;
    border-radius: 6px; outline: none; width: 100%; box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .del-modal-input:focus { border-color: #e74c3c; }
  .del-modal-err {
    font-size: 12px; color: #e74c3c; margin: 0;
  }
  .del-modal-actions {
    display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem;
  }
  .del-btn-cancel {
    background: transparent; border: 1px solid var(--border);
    color: var(--text-secondary); font-family: "Space Grotesk", sans-serif;
    font-size: 13px; font-weight: 500; padding: 0.5rem 1rem;
    border-radius: 6px; cursor: pointer; transition: background 0.12s;
  }
  .del-btn-cancel:hover { background: var(--row-hover); color: var(--text-primary); }
  .del-btn-confirm {
    background: #7f1d1d; border: 1px solid #991b1b;
    color: #fca5a5; font-family: "Space Grotesk", sans-serif;
    font-size: 13px; font-weight: 600; padding: 0.5rem 1.1rem;
    border-radius: 6px; cursor: pointer; transition: background 0.12s, opacity 0.12s;
  }
  .del-btn-confirm:hover:not(:disabled) { background: #991b1b; }
  .del-btn-confirm:disabled { opacity: 0.35; cursor: default; }
</style>
