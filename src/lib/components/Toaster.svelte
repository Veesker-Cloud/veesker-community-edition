<script lang="ts">
  import { toasts } from "$lib/stores/toasts.svelte";
</script>

<div class="toaster">
  {#each toasts.all as t (t.id)}
    <div class="toast toast-{t.kind}" role={t.kind === "error" ? "alert" : "status"}>
      {t.message}
      <button onclick={() => toasts.dismiss(t.id)} aria-label="Dismiss">×</button>
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 1400;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .toast {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    min-width: 220px;
    max-width: 400px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }
  .toast button {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.1rem;
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
  }
  .toast button:hover {
    color: var(--text-primary);
  }
  .toast-error {
    border-left: 3px solid var(--error-text);
  }
  .toast-success {
    border-left: 3px solid var(--success-text);
  }
  .toast-warning {
    border-left: 3px solid var(--warn-text);
  }
  .toast-info {
    border-left: 3px solid var(--accent);
  }
</style>
