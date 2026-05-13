<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { getContext } from "svelte";
  import { sandboxes } from "$lib/stores/sandboxes.svelte";
  import { sandboxKeypair } from "$lib/stores/sandbox-keypair.svelte";
  import SandboxCard from "$lib/workspace/SandboxCard.svelte";
  import SandboxEncryptionModal from "$lib/workspace/SandboxEncryptionModal.svelte";
  import LoginModal from "$lib/workspace/LoginModal.svelte";

  const authCtx = getContext<{ tier: "ce" | "cloud"; email: string }>("auth");

  let showEncryptionModal = $state(false);
  let showLogin = $state(false);
  let deletingIds = $state<Set<string>>(new Set());
  let leavingIds = $state<Set<string>>(new Set());
  let lastRefreshAt = $state(0);
  const REFRESH_DEBOUNCE_MS = 30_000;

  // Detect "you're signed out" cleanly. The keypair store today surfaces
  // raw HTTP error text like "PUT /v1/users/me/pubkey → 401" — that's
  // useful for support but not for users; recognize the signed-out case
  // and route to a friendlier CTA instead of the raw error banner.
  const isSignedOut = $derived(
    authCtx.tier === "ce" || /\b401\b/.test(sandboxKeypair.error ?? ""),
  );

  $effect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRefreshAt < REFRESH_DEBOUNCE_MS) return;
      lastRefreshAt = now;
      void sandboxes.load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  function openSandbox(id: string) {
    void goto(`/sandboxes/${id}`);
  }

  function pullSandbox(id: string) {
    void sandboxes.pull(id);
  }

  async function deleteSandboxAction(id: string) {
    if (deletingIds.has(id)) return;
    const next = new Set(deletingIds);
    next.add(id);
    deletingIds = next;
    try {
      await sandboxes.delete(id);
    } catch {
      // Error already surfaced through sandboxes.error banner; nothing else
      // to do here. The card stays on screen so the user can retry.
    } finally {
      const after = new Set(deletingIds);
      after.delete(id);
      deletingIds = after;
    }
  }

  async function leaveSandboxAction(id: string) {
    if (leavingIds.has(id)) return;
    const next = new Set(leavingIds);
    next.add(id);
    leavingIds = next;
    try {
      await sandboxes.leave(id);
    } catch {
      // surfaced via sandboxes.error banner
    } finally {
      const after = new Set(leavingIds);
      after.delete(id);
      leavingIds = after;
    }
  }

  async function republishSandboxAction(id: string) {
    try {
      const { sandboxId } = sandboxes.republish(id);
      await goto(`/sandboxes/publish?republishId=${encodeURIComponent(sandboxId)}`);
    } catch (e) {
      sandboxes.error = (e as Error).message ?? String(e);
    }
  }
</script>

<header class="page-header">
  <div class="title-group">
    <button
      type="button"
      class="back"
      aria-label="Back to connections"
      title="Back to connections"
      onclick={() => void goto("/")}
    >←</button>
    <h1>Sandboxes</h1>
  </div>
  <div class="header-actions">
    <span class="counts">{sandboxes.cached.length} cached · {sandboxes.remote.length} remote</span>
    <button
      type="button"
      class="btn-primary"
      onclick={() => void goto("/sandboxes/publish")}
    >+ Publish new sandbox</button>
    <button
      type="button"
      class="gear"
      title="Encryption settings"
      aria-label="Encryption settings"
      onclick={() => (showEncryptionModal = true)}
    >⚙</button>
  </div>
</header>

{#if sandboxes.newCount > 0}
  <div class="banner-info banner-new">
    <span><strong>{sandboxes.newCount}</strong> new sandbox{sandboxes.newCount === 1 ? "" : "es"} shared with you</span>
    <button type="button" onclick={() => void sandboxes.markAllSeen()}>Mark all as seen</button>
  </div>
{/if}

{#if isSignedOut}
  <div class="banner-info">
    <span>Sandboxes need Veesker Cloud sync.</span>
    <button type="button" onclick={() => (showLogin = true)}>Sign in to Cloud</button>
  </div>
{:else if sandboxKeypair.error}
  <div class="banner-warn">
    <span>Encryption setup incomplete.</span>
    <button type="button" onclick={() => (showEncryptionModal = true)}>Open Settings</button>
    <details class="diag">
      <summary>Technical details</summary>
      <code>{sandboxKeypair.error}</code>
    </details>
  </div>
{/if}

{#if sandboxes.error}
  <div class="banner-error">Couldn't load sandboxes: {sandboxes.error}</div>
{/if}

{#if sandboxes.loading && sandboxes.all.length === 0}
  <p class="empty">Loading…</p>
{:else if sandboxes.all.length === 0}
  <div class="empty-state">
    <p>No sandboxes yet.</p>
    {#if isSignedOut}
      <p class="hint">Sign in to Cloud to receive shared sandboxes or publish your own.</p>
    {:else if authCtx.tier === "cloud"}
      <p class="hint">Click <strong>+ Publish new sandbox</strong> to share a slice of your schema with teammates.</p>
    {:else}
      <p class="hint">Ask a teammate to share one with you.</p>
    {/if}
  </div>
{:else}
  <div class="grid">
    {#each sandboxes.all as sb (sb.sandbox_id)}
      <SandboxCard
        sandbox={sb}
        isPulling={sandboxes.pulling.has(sb.sandbox_id)}
        isDeleting={deletingIds.has(sb.sandbox_id)}
        isLeaving={leavingIds.has(sb.sandbox_id)}
        isNew={!sb.cached && !sandboxes.lastSeenIds.has(sb.sandbox_id)}
        isStaleVersion={sandboxes.staleVersionIds.has(sb.sandbox_id)}
        onOpen={() => openSandbox(sb.sandbox_id)}
        onPull={() => pullSandbox(sb.sandbox_id)}
        onDelete={() => void deleteSandboxAction(sb.sandbox_id)}
        onLeave={() => void leaveSandboxAction(sb.sandbox_id)}
        onRepublish={sb.status === "ready"
          ? () => void republishSandboxAction(sb.sandbox_id)
          : undefined}
      />
    {/each}
  </div>
{/if}

{#if showEncryptionModal}
  <SandboxEncryptionModal onClose={() => showEncryptionModal = false} />
{/if}

{#if showLogin}
  <LoginModal onClose={() => (showLogin = false)} />
{/if}

<style>
  .page-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px; border-bottom: 1px solid var(--border);
    max-width: 800px;
    margin: 0 auto;
  }
  .banner-info, .banner-warn, .banner-error,
  .grid, .empty-state, .empty {
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
    width: calc(100% - 32px);
    box-sizing: border-box;
  }
  .title-group { display: flex; align-items: center; gap: 12px; }
  .back {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 12px;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    font: inherit;
  }
  .back:hover {
    color: var(--text-primary);
    background: var(--bg-surface-alt);
  }
  h1 { margin: 0; color: var(--text-primary); }
  .header-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    row-gap: 8px;
  }
  .counts { color: var(--text-muted); font-size: 12px; }
  .gear { background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; cursor: pointer; color: var(--text-muted); font: inherit; }
  .btn-primary {
    background: var(--accent, #3b82f6);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .banner-info, .banner-warn, .banner-error {
    padding: 10px 16px;
    border-left: 3px solid;
    margin: 8px auto;
    border-radius: 3px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .banner-info {
    background: rgba(59, 130, 246, 0.12);
    color: var(--text-primary);
    border-left-color: var(--accent, #3b82f6);
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
  .banner-warn {
    background: rgba(245, 158, 11, 0.15);
    color: var(--warn-text, #fbbf24);
    border-left-color: #f59e0b;
  }
  .banner-warn button {
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    border-radius: 4px;
    padding: 2px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .banner-warn .diag {
    flex-basis: 100%;
    font-size: 11px;
    color: var(--text-muted);
  }
  .banner-warn .diag summary { cursor: pointer; }
  .banner-warn .diag code {
    font-family: monospace;
    background: var(--bg-surface-alt);
    padding: 2px 6px;
    border-radius: 3px;
  }
  .banner-error {
    background: rgba(239, 68, 68, 0.15);
    color: var(--error-text, #f87171);
    border-left-color: #ef4444;
  }
  .empty, .empty-state { padding: 32px; text-align: center; color: var(--text-muted); }
  .empty-state .hint { font-size: 12px; margin-top: 8px; }
  .grid {
    padding: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
</style>
