<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import {
    ordsClientsList,
    ordsClientsCreate,
    ordsClientsRevoke,
    ordsRolesList,
    type RestClient,
  } from "$lib/workspace";

  type Props = {
    onClose: () => void;
    onOpenBootstrap?: () => void;
  };
  let { onClose, onOpenBootstrap }: Props = $props();

  let clients = $state<RestClient[]>([]);
  let rolesList = $state<string[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let showCreate = $state(false);
  let newName = $state("");
  let newDescription = $state("");
  let newRoles = $state<string[]>([]);
  let creating = $state(false);

  let createdSecret = $state<{ clientId: string; clientSecret: string; name: string } | null>(null);

  let revokingName = $state<string | null>(null);

  // Tauri 2's WebView blocks window.confirm() — render an inline alertdialog
  // instead so the destructive action doesn't silently auto-cancel.
  let pendingRevokeName = $state<string | null>(null);

  function requestRevoke(name: string) {
    pendingRevokeName = name;
  }

  function cancelRevoke() {
    pendingRevokeName = null;
  }

  async function confirmRevoke() {
    const name = pendingRevokeName;
    pendingRevokeName = null;
    if (!name) return;
    revokingName = name;
    const res = await ordsClientsRevoke(name);
    revokingName = null;
    if (res.ok) {
      await load();
    } else {
      error = res.error.message;
    }
  }

  async function load() {
    loading = true;
    error = null;
    const [c, r] = await Promise.all([ordsClientsList(), ordsRolesList()]);
    loading = false;
    if (c.ok) clients = c.data.clients;
    else error = c.error.message;
    if (r.ok) rolesList = r.data.roles;
  }

  $effect(() => { void load(); });

  function toggleRole(role: string) {
    newRoles = newRoles.includes(role)
      ? newRoles.filter((r) => r !== role)
      : [...newRoles, role];
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    creating = true;
    error = null;
    const res = await ordsClientsCreate(newName.trim(), newDescription.trim(), newRoles);
    creating = false;
    if (res.ok) {
      createdSecret = {
        clientId: res.data.clientId,
        clientSecret: res.data.clientSecret,
        name: newName.trim(),
      };
      newName = "";
      newDescription = "";
      newRoles = [];
      showCreate = false;
      await load();
    } else {
      error = res.error.message;
    }
  }


  async function handleRevoke(name: string) {
    if (!confirm(`Revoke client "${name}"? This action is irreversible.`)) return;
    revokingName = name;
    const res = await ordsClientsRevoke(name);
    revokingName = null;
    if (res.ok) {
      await load();
    } else {
      error = res.error.message;
    }
  }

  function copyToClipboard(text: string) {
    void navigator.clipboard.writeText(text);
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && pendingRevokeName) {
      e.stopPropagation();
      cancelRevoke();
    }
  }}
/>

<div
  class="modal-backdrop"
  onclick={onClose}
  onkeydown={(e) => e.key === "Escape" && !pendingRevokeName && onClose()}
  role="presentation"
>
  <div
    class="modal"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="head">
      <span class="title">API Clients (OAuth 2.0)</span>
      <div class="actions">
        {#if !showCreate}
          <button class="btn primary" onclick={() => showCreate = true}>+ New Client</button>
        {/if}
        <button class="close" onclick={onClose} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="body">
      {#if error}
        <div class="error">
          {error}
          {#if onOpenBootstrap && (error.includes("ORDS") || error.includes("OAUTH"))}
            <button class="btn small" style="margin-left: 8px" onclick={() => { onClose(); onOpenBootstrap?.(); }}>
              Configure ORDS
            </button>
          {/if}
        </div>
      {/if}

      {#if showCreate}
        <div class="create-form">
          <h3>New OAuth Client</h3>
          <div class="row">
            <span class="label">Name:</span>
            <input class="input" bind:value={newName} placeholder="mobile-app" />
          </div>
          <div class="row">
            <span class="label">Description:</span>
            <input class="input" bind:value={newDescription} placeholder="Mobile app for sales team" />
          </div>
          <div class="row">
            <span class="label">Roles:</span>
            <div class="role-chips">
              {#if rolesList.length === 0}
                <span class="hint">No roles available. Create a role via the endpoint builder first.</span>
              {/if}
              {#each rolesList as r (r)}
                <button
                  type="button"
                  class="role-chip"
                  class:selected={newRoles.includes(r)}
                  onclick={() => toggleRole(r)}
                >{r}</button>
              {/each}
            </div>
          </div>
          <div class="form-actions">
            <button class="btn" onclick={() => { showCreate = false; newName = ""; newDescription = ""; newRoles = []; }}>Cancel</button>
            <button class="btn primary" onclick={() => void handleCreate()} disabled={creating || !newName.trim()}>
              {creating ? "Creating…" : "Create Client"}
            </button>
          </div>
        </div>
      {/if}

      {#if loading}
        <div class="state-msg">Loading clients…</div>
      {:else if clients.length === 0 && !showCreate}
        <div class="state-msg">No OAuth clients created yet.</div>
      {:else}
        <table class="clients-table">
          <thead>
            <tr><th>Name</th><th>Description</th><th>Created on</th><th></th></tr>
          </thead>
          <tbody>
            {#each clients as c (c.name)}
              <tr>
                <td><code>{c.name}</code></td>
                <td>{c.description ?? "—"}</td>
                <td>{c.createdOn ? c.createdOn.slice(0, 10) : "—"}</td>
                <td>
                  <button
                    class="btn small danger"
                    onclick={() => requestRevoke(c.name)}
                    disabled={revokingName === c.name}
                  >
                    {revokingName === c.name ? "…" : "Revoke"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>

  {#if pendingRevokeName}
    <div class="confirm-modal" role="alertdialog" aria-modal="true" aria-label="Confirm revoke">
      <div class="confirm-card">
        <h3>Revoke OAuth client "{pendingRevokeName}"?</h3>
        <p class="confirm-text">This action cannot be undone. Applications using this client will lose access immediately.</p>
        <div class="confirm-actions">
          <button type="button" class="btn-cancel" onclick={cancelRevoke}>Cancel</button>
          <button type="button" class="btn-confirm" onclick={() => void confirmRevoke()}>Revoke</button>
        </div>
      </div>
    </div>
  {/if}

  {#if createdSecret}
    <div class="secret-modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="secret-card">
        <h3>Client created: {createdSecret.name}</h3>
        <p class="secret-warn">⚠ <strong>Save now.</strong> We will not be able to show the secret again.</p>
        <div class="cred-row">
          <span class="cred-label">Client ID:</span>
          <code class="cred-value">{createdSecret.clientId}</code>
          <button class="btn small" onclick={() => copyToClipboard(createdSecret!.clientId)}>📋</button>
        </div>
        <div class="cred-row">
          <span class="cred-label">Client Secret:</span>
          <code class="cred-value secret">{createdSecret.clientSecret}</code>
          <button class="btn small" onclick={() => copyToClipboard(createdSecret!.clientSecret)}>📋</button>
        </div>
        <div class="form-actions">
          <button class="btn primary" onclick={() => createdSecret = null}>Done</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px;
    width: 760px; max-width: 90vw; max-height: 85vh; display: flex; flex-direction: column;
  }
  .head {
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
  }
  .title { font-weight: 600; color: var(--text-primary); }
  .actions { display: flex; gap: 8px; align-items: center; }
  .close {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; padding: 4px 8px; font-size: 14px;
  }
  .close:hover { color: var(--text-primary); }
  .body { padding: 16px; overflow-y: auto; flex: 1; color: var(--text-primary); font-size: 12px; }

  .error {
    background: rgba(179,62,31,0.15); border: 1px solid rgba(179,62,31,0.3);
    color: #f5a08a; padding: 8px 10px; border-radius: 4px;
    font-size: 11.5px; margin-bottom: 12px;
  }
  .state-msg { padding: 20px; color: var(--text-muted); text-align: center; font-size: 12px; }

  .create-form {
    background: var(--bg-surface-alt); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; margin-bottom: 16px;
  }
  .create-form h3 { font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin: 0 0 10px; }
  .row { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; }
  .label { color: var(--text-muted); min-width: 80px; font-size: 11.5px; padding-top: 4px; }
  .input {
    flex: 1; background: var(--input-bg); border: 1px solid var(--border);
    color: var(--text-primary); padding: 4px 8px; border-radius: 4px;
    font-size: 11.5px;
  }
  .role-chips { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }
  .role-chip {
    background: var(--input-bg); border: 1px solid var(--border);
    color: var(--text-primary); font-family: "JetBrains Mono", monospace;
    font-size: 10.5px; padding: 3px 9px; border-radius: 4px; cursor: pointer;
  }
  .role-chip:hover { background: var(--row-hover); }
  .role-chip.selected {
    background: rgba(179,62,31,0.25); border-color: rgba(179,62,31,0.5); color: #f5a08a;
  }
  .hint { font-size: 11px; color: var(--text-muted); font-style: italic; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }

  .clients-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .clients-table th {
    text-align: left; padding: 6px 8px;
    color: var(--text-muted); font-weight: 600;
    text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em;
    border-bottom: 1px solid var(--border);
  }
  .clients-table td {
    padding: 6px 8px; border-bottom: 1px solid var(--border);
  }
  .clients-table code {
    font-family: "JetBrains Mono", monospace;
    background: var(--bg-surface-alt); padding: 1px 5px; border-radius: 3px;
  }

  .btn {
    background: var(--bg-surface-alt); border: 1px solid var(--border);
    color: var(--text-primary); padding: 5px 12px; border-radius: 4px;
    cursor: pointer; font-size: 11.5px;
  }
  .btn.small { padding: 3px 8px; font-size: 10.5px; }
  .btn.primary { background: rgba(179,62,31,0.2); border-color: rgba(179,62,31,0.45); color: #f5a08a; }
  .btn.primary:hover:not(:disabled) { background: rgba(179,62,31,0.35); }
  .btn.danger { color: #f5a08a; }
  .btn.danger:hover:not(:disabled) { background: rgba(179,62,31,0.15); }
  .btn:hover:not(:disabled) { background: var(--row-hover); }
  .btn:disabled { opacity: 0.5; cursor: default; }

  .secret-modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 1100;
  }
  .secret-card {
    background: var(--bg-surface); border: 1px solid rgba(232,197,71,0.5); border-radius: 8px;
    padding: 20px; max-width: 600px; width: 90vw;
  }
  .secret-card h3 { margin: 0 0 10px; font-size: 14px; color: var(--text-primary); }
  .secret-warn {
    background: rgba(232,197,71,0.1); border: 1px solid rgba(232,197,71,0.3);
    color: #e8c547; padding: 8px 12px; border-radius: 4px;
    font-size: 11.5px; margin: 10px 0;
  }
  .cred-row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .cred-label { color: var(--text-muted); font-size: 11px; min-width: 100px; }
  .cred-value {
    flex: 1; font-family: "JetBrains Mono", monospace;
    background: var(--bg-page); padding: 4px 8px; border-radius: 3px;
    font-size: 10.5px; color: var(--text-primary); word-break: break-all;
  }
  .cred-value.secret { color: #f5a08a; font-weight: 600; }

  .confirm-modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 1100;
  }
  .confirm-card {
    background: var(--bg-surface); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px;
    padding: 20px; max-width: 480px; width: 90vw;
  }
  .confirm-card h3 { margin: 0 0 10px; font-size: 14px; color: var(--text-primary); }
  .confirm-text {
    margin: 0 0 14px;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.45;
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
    font-family: "Inter", -apple-system, system-ui, sans-serif;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-confirm {
    background: rgba(239, 68, 68, 0.85);
    color: white;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 10px;
    font-family: "Inter", -apple-system, system-ui, sans-serif;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-confirm:hover { background: rgba(239, 68, 68, 1); }
</style>
