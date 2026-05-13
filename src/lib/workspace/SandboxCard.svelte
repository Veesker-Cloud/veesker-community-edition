<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import type { SandboxSummary } from "$lib/sandbox";

  type Props = {
    sandbox: SandboxSummary;
    onOpen?: () => void;
    onPull?: () => void;
    onDelete?: () => void;
    onLeave?: () => void;
    onRepublish?: () => void;
    isPulling?: boolean;
    isDeleting?: boolean;
    isLeaving?: boolean;
    isRepublishing?: boolean;
    isNew?: boolean;
    isStaleVersion?: boolean;
  };
  let {
    sandbox,
    onOpen,
    onPull,
    onDelete,
    onLeave,
    onRepublish,
    isPulling = false,
    isDeleting = false,
    isLeaving = false,
    isRepublishing = false,
    isNew = false,
    isStaleVersion = false,
  }: Props = $props();

  // Em-dash for pending/unknown (server only sets blob_size_bytes after
  // /finalize). Adaptive units so a 50 KB test sandbox doesn't render as
  // "0.0 MB" — that read like the upload was empty even when it wasn't.
  function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }
  function formatRelativeFuture(iso: string): string {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) {
      const ago = Math.floor(-ms / 86400_000);
      return ago >= 1 ? `${ago}d ago` : "just now";
    }
    const days = Math.floor(ms / 86400_000);
    if (days >= 1) return `${days}d`;
    const hours = Math.floor(ms / 3600_000);
    if (hours >= 1) return `${hours}h`;
    const mins = Math.max(1, Math.floor(ms / 60_000));
    return `${mins}min`;
  }

  const sizeLabel = $derived(formatBytes(sandbox.blob_size_bytes));
  const expiresIn = $derived(formatRelativeFuture(sandbox.expires_at));
  const expiresTooltip = $derived(new Date(sandbox.expires_at).toLocaleString());
  const isExpired = $derived(sandbox.status === "expired" || sandbox.status === "deleted");
  const busy = $derived(isPulling || isDeleting || isLeaving || isRepublishing);

  // Tauri 2's WebView blocks window.confirm() (and alert/prompt) unless the
  // dialog plugin is wired in — clicking the ✕ used to throw `dialog.confirm
  // not allowed. Command not found` and the delete RPC never ran. Render an
  // inline confirmation popover instead so we don't need to widen the
  // capability surface for one feature.
  let showConfirm = $state(false);
  let showRepublishConfirm = $state(false);

  function openConfirm(e: MouseEvent) {
    e.stopPropagation();
    if (sandbox.role === "owner") {
      if (!onDelete || isDeleting) return;
    } else {
      if (!onLeave || isLeaving) return;
    }
    showConfirm = true;
  }
  function cancelDelete() {
    showConfirm = false;
  }
  function confirmAction() {
    showConfirm = false;
    if (sandbox.role === "owner") onDelete?.();
    else onLeave?.();
  }
  function openRepublishConfirm(e: MouseEvent) {
    e.stopPropagation();
    if (!onRepublish || isRepublishing) return;
    showRepublishConfirm = true;
  }
  function cancelRepublish() {
    showRepublishConfirm = false;
  }
  function confirmRepublish() {
    showRepublishConfirm = false;
    onRepublish?.();
  }
  function handleCardClick() {
    if (busy || isExpired) return;
    if (sandbox.cached) onOpen?.();
    else onPull?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<li
  class="card sandbox"
  class:card-deleting={isDeleting || isLeaving}
  class:expired={isExpired}
  onclick={handleCardClick}
  onkeydown={(e) => { if (e.key === "Enter") handleCardClick(); }}
  tabindex={busy ? -1 : 0}
  role="button"
  aria-disabled={busy}
>
  <div class="card-icon">
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 6l7-3 7 3v8l-7 3-7-3V6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M3 6l7 3 7-3" stroke="currentColor" stroke-width="1.2"/>
      <path d="M10 9v9" stroke="currentColor" stroke-width="1.2"/>
    </svg>
  </div>
  <div class="card-body">
    <div class="card-name">
      {sandbox.name}
      <span class="sandbox-pill">SANDBOX</span>
      {#if isNew && !sandbox.cached}<span class="new-pill">NEW</span>{/if}
      {#if isStaleVersion}<span class="stale-pill" title="Owner republished — pull to refresh">🔄 New version</span>{/if}
    </div>
    <div class="card-meta">
      <span class="card-size mono">{sizeLabel}</span>
      <span class="card-sep">·</span>
      <span class="card-expires" title={expiresTooltip}>
        {isExpired ? "expired" : `expires in ${expiresIn}`}
      </span>
      <span class="card-sep">·</span>
      <span class="status-dot" class:cached={sandbox.cached} class:remote={!sandbox.cached && !isExpired} class:expired={isExpired}></span>
      <span class="status-text">
        {#if isExpired}expired{:else if sandbox.cached}cached{:else}remote{/if}
      </span>
      {#if sandbox.role}
        <span class="card-sep">·</span>
        <span class="role-badge {sandbox.role}">{sandbox.role}</span>
      {/if}
    </div>
  </div>
  <div class="card-actions" role="none">
    {#if isPulling}
      <span class="action-spinner" aria-label="Pulling"></span>
    {/if}
    {#if sandbox.role === "owner" && onRepublish}
      <button
        type="button"
        class="action-btn republish"
        title="Republish — refresh data from source"
        aria-label="Republish {sandbox.name}"
        disabled={isRepublishing}
        onclick={openRepublishConfirm}
      >
        {#if isRepublishing}
          <span class="action-spinner" aria-label="Republishing"></span>
        {:else}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 6a4 4 0 016.83-2.83L10 4.34M10 2v2.34H7.66" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 6a4 4 0 01-6.83 2.83L2 7.66M2 10V7.66h2.34" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </button>
    {/if}
    {#if (sandbox.role === "owner" && onDelete) || (sandbox.role === "member" && onLeave)}
      <button
        type="button"
        class="action-btn delete"
        title={sandbox.role === "owner" ? "Delete sandbox" : "Leave sandbox"}
        aria-label={sandbox.role === "owner" ? `Delete ${sandbox.name}` : `Leave ${sandbox.name}`}
        disabled={isDeleting || isLeaving}
        onclick={openConfirm}
      >
        {#if isDeleting || isLeaving}
          <span class="action-spinner" aria-label="Working"></span>
        {:else}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 3h8M5 3V2h2v1M10 3l-.6 7.5A1 1 0 018.4 11H3.6a1 1 0 01-1-.5L2 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </button>
    {/if}
    <span class="open-arrow" aria-hidden="true">→</span>
  </div>

  {#if showConfirm}
    <div class="confirm-row" role="alertdialog" aria-label="Confirm action">
      <p class="confirm-text">
        {#if sandbox.role === "owner"}
          {sandbox.cached
            ? "Delete this sandbox? Local cache is removed and the server is asked to delete the remote copy. Recipients lose access on next refresh."
            : "Remove this sandbox from your list? The server-side copy is deleted; recipients lose access on next refresh."}
        {:else}
          Leave this sandbox? Your local cache is removed and you lose access to the remote copy. The owner is not notified.
        {/if}
      </p>
      <div class="confirm-actions">
        <button type="button" class="btn-cancel" onclick={(e) => { e.stopPropagation(); cancelDelete(); }}>Cancel</button>
        <button type="button" class="btn-confirm" onclick={(e) => { e.stopPropagation(); confirmAction(); }}>
          {#if sandbox.role === "owner"}{sandbox.cached ? "Delete" : "Remove"}{:else}Leave{/if}
        </button>
      </div>
    </div>
  {/if}

  {#if showRepublishConfirm}
    <div class="confirm-row republish-confirm" role="alertdialog" aria-label="Confirm republish">
      <p class="confirm-text">
        Refresh data from the source database for "{sandbox.name}"?
        Recipients keep access automatically — they'll be prompted to re-pull on next refresh.
        Existing data on R2 will be overwritten.
      </p>
      <div class="confirm-actions">
        <button type="button" class="btn-cancel" onclick={(e) => { e.stopPropagation(); cancelRepublish(); }}>Cancel</button>
        <button type="button" class="btn-confirm btn-republish" onclick={(e) => { e.stopPropagation(); confirmRepublish(); }}>Republish</button>
      </div>
    </div>
  {/if}
</li>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.1rem;
    background: var(--bg-surface-raised);
    border: 1px solid var(--accent, #3b82f6);
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 0.12s, box-shadow 0.12s, transform 0.1s;
    user-select: none;
    position: relative;
    flex-wrap: wrap;
  }
  .card:hover {
    background: var(--row-hover);
    box-shadow: 0 2px 10px rgba(59, 130, 246, 0.18);
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
  .card.expired {
    border-color: var(--border);
    opacity: 0.6;
    cursor: default;
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
    background: rgba(59, 130, 246, 0.1);
    color: var(--accent, #3b82f6);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.12s;
  }
  .card:hover .card-icon {
    background: rgba(59, 130, 246, 0.18);
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
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 11.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    flex-wrap: wrap;
  }
  .mono { font-family: "JetBrains Mono", "SF Mono", monospace; }
  .card-sep { opacity: 0.4; }

  .new-pill {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.5px;
    background: var(--accent, #3b82f6);
    color: white;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .stale-pill {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.5px;
    background: rgba(245, 158, 11, 0.18);
    color: #d97706;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .sandbox-pill {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.07em;
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.4);
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .role-badge {
    font-family: "Space Grotesk", sans-serif;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .role-badge.owner {
    background: rgba(59, 130, 246, 0.12);
    color: var(--accent, #3b82f6);
  }
  .role-badge.member {
    background: rgba(110, 110, 110, 0.12);
    color: var(--text-secondary);
  }

  .status-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.cached { background: var(--accent, #3b82f6); }
  .status-dot.remote { background: var(--text-muted); }
  .status-dot.expired { background: var(--border); }
  .status-text { color: var(--text-muted); }

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
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 0.3rem 0.4rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    color: var(--text-secondary);
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .action-btn.delete:hover {
    background: rgba(239, 68, 68, 0.08);
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.2);
  }
  .action-btn.republish:hover {
    background: rgba(59, 130, 246, 0.08);
    color: var(--accent, #3b82f6);
    border-color: rgba(59, 130, 246, 0.2);
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

  .confirm-row {
    flex-basis: 100%;
    margin-top: 8px;
    padding: 8px;
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: 6px;
    background: rgba(239, 68, 68, 0.08);
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: default;
  }
  .confirm-text {
    margin: 0;
    font-size: 11px;
    color: var(--text-primary);
    line-height: 1.4;
  }
  .confirm-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .btn-cancel {
    background: transparent;
    color: var(--text-muted);
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-confirm {
    background: rgba(239, 68, 68, 0.85);
    color: white;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 10px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-confirm:hover { background: rgba(239, 68, 68, 1); }

  .confirm-row.republish-confirm {
    border-color: rgba(59, 130, 246, 0.35);
    background: rgba(59, 130, 246, 0.08);
  }
  .btn-confirm.btn-republish {
    background: rgba(59, 130, 246, 0.85);
  }
  .btn-confirm.btn-republish:hover {
    background: rgba(59, 130, 246, 1);
  }
</style>
