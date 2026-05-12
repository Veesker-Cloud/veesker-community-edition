<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import type { OrdsDetectResult } from "$lib/workspace";

  type Props = {
    result: OrdsDetectResult;
    schemaName: string;
    onEnableSchema: () => Promise<void>;
    onSetBaseUrl: (url: string) => void;
    onClose: () => void;
  };
  let { result, schemaName, onEnableSchema, onSetBaseUrl, onClose }: Props = $props();

  let baseUrlInput = $state("");
  let enabling = $state(false);

  const variant = $derived.by(() => {
    if (!result.installed) return "not-installed";
    if (!result.userHasAccess) return "no-access";
    if (!result.currentSchemaEnabled) return "schema-disabled";
    if (!result.hasAdminRole) return "no-privilege";
    if (!result.ordsBaseUrl) return "no-url";
    return "ok";
  });

  async function handleEnable() {
    enabling = true;
    try { await onEnableSchema(); } finally { enabling = false; }
  }

  function handleSetUrl() {
    if (baseUrlInput.trim()) onSetBaseUrl(baseUrlInput.trim());
  }
</script>

<div
  class="panel"
  role="dialog"
  aria-modal="false"
  aria-label="ORDS Setup"
  tabindex="-1"
  onkeydown={(e) => e.key === "Escape" && onClose()}
>
  <div class="panel-head">
    <span class="panel-title">VRAS · ORDS</span>
    <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
  </div>
  <div class="panel-body">
    {#if variant === "not-installed"}
      <p class="label-warn">ORDS não detectado</p>
      <p class="hint">Peça ao DBA para executar:</p>
      <pre class="cmd">@$ORACLE_HOME/ords/install.sql</pre>
      <p class="hint">
        <a href="https://docs.oracle.com/en/database/oracle/oracle-rest-data-services/" target="_blank" rel="noopener">Documentação oficial</a>
      </p>
    {:else if variant === "no-access"}
      <p class="label-warn">Sem acesso ao ORDS</p>
      <p class="hint">User <code>{schemaName}</code> needs the grant:</p>
      <pre class="cmd">GRANT ORDS_ADMINISTRATOR_ROLE TO {schemaName};</pre>
    {:else if variant === "schema-disabled"}
      <p class="label-warn">Schema não habilitado</p>
      <p class="hint">Schema <code>{schemaName}</code> must be enabled for ORDS.</p>
      <button class="primary-btn" onclick={() => void handleEnable()} disabled={enabling}>
        {enabling ? "Habilitando…" : "Habilitar agora"}
      </button>
    {:else if variant === "no-privilege"}
      <p class="label-warn">Privilégio insuficiente</p>
      <p class="hint">Grant necessário (executar como SYS):</p>
      <pre class="cmd">GRANT ORDS_ADMINISTRATOR_ROLE TO {schemaName};</pre>
    {:else if variant === "no-url"}
      <p class="label-warn">URL do ORDS não detectada</p>
      <input
        class="url-input"
        type="text"
        placeholder="https://servidor:8443/ords"
        bind:value={baseUrlInput}
        onkeydown={(e) => e.key === "Enter" && handleSetUrl()}
      />
      <button class="primary-btn" onclick={handleSetUrl} disabled={!baseUrlInput.trim()}>
        Save
      </button>
    {:else}
      <p class="label-ok">ORDS {result.version ?? ""} configurado.</p>
    {/if}
  </div>
</div>

<style>
  .panel {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 900;
    width: 300px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.35);
    animation: slide-in 0.18s ease;
  }
  @keyframes slide-in {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .panel-title {
    font-size: 10.5px;
    font-family: "Space Grotesk", sans-serif;
    font-weight: 600;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .close-btn {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 3px;
  }
  .close-btn:hover { color: var(--text-primary); background: rgba(255,255,255,0.06); }
  .panel-body { padding: 12px; }
  .label-warn {
    font-size: 12px;
    font-weight: 600;
    color: #e8c87e;
    margin: 0 0 6px;
  }
  .label-ok {
    font-size: 12px;
    font-weight: 600;
    color: #7ec96a;
    margin: 0;
  }
  .hint {
    font-size: 11px;
    color: var(--text-muted);
    margin: 4px 0;
    line-height: 1.45;
  }
  .hint a { color: #6aa0f5; text-decoration: none; }
  .hint a:hover { text-decoration: underline; }
  .cmd {
    background: var(--bg-surface-alt);
    border: 1px solid var(--border);
    padding: 7px 10px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 10.5px;
    color: var(--text-primary);
    margin: 6px 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .primary-btn {
    background: rgba(179,62,31,0.2); border: 1px solid rgba(179,62,31,0.5);
    color: #f5a08a; padding: 5px 12px; border-radius: 4px;
    font-size: 11.5px; font-weight: 600; cursor: pointer; margin-top: 6px;
  }
  .primary-btn:hover:not(:disabled) { background: rgba(179,62,31,0.35); }
  .primary-btn:disabled { opacity: 0.5; cursor: default; }
  .url-input {
    width: 100%; padding: 5px 8px; border: 1px solid var(--border);
    border-radius: 4px; background: var(--bg-surface-alt); color: var(--text-primary);
    font-size: 11.5px; font-family: monospace; margin-top: 4px;
    box-sizing: border-box;
  }
  code {
    font-family: monospace; background: var(--bg-surface-alt);
    padding: 1px 4px; border-radius: 3px; font-size: 11px;
  }
</style>
