<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  type Props = {
    sandboxId: string;
    reason: "deleted" | "expired" | "not_recipient";
    onDismiss: () => void;
  };
  let { sandboxId, reason, onDismiss }: Props = $props();
</script>

<div class="overlay" role="presentation" onclick={onDismiss}>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <h3>Sandbox revoked</h3>
    <p>Sandbox <code>{sandboxId}</code> was {reason}.</p>
    <p class="hint">It has been closed and removed from your list.</p>
    <button onclick={onDismiss}>Dismiss</button>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px; padding: 24px; max-width: 400px; }
  h3 { margin: 0 0 12px; color: var(--text-primary); }
  p { color: var(--text-muted); margin: 8px 0; }
  .hint { font-size: 12px; }
  code { background: var(--bg-surface-alt); padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  button { margin-top: 12px; padding: 6px 16px; background: var(--bg-surface-alt); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
</style>
