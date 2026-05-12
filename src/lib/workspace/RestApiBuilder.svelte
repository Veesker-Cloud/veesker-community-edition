<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import {
    objectsList,
    objectsListPlsql,
    ordsRolesList,
    aiSuggestEndpoint,
    aiKeyGet,
    type AiEndpointSuggestion,
  } from "$lib/workspace";

  type EndpointType = "auto-crud" | "custom-sql" | "procedure";
  type AuthMode = "none" | "role" | "oauth";

  export type BuilderConfig = {
    type: EndpointType;
    sourceObject: { owner: string; name: string; kind: string } | null;
    sourceSql: string | null;
    operations: string[];
    moduleMode: "new" | "existing";
    moduleName: string;
    basePath: string;
    routePattern: string;
    method: string;
    authMode: AuthMode;
    authRole: string | null;
  };

  type Props = {
    owner: string;
    initialKind?: "table" | "view" | "procedure" | "function" | null;
    initialObject?: { owner: string; name: string } | null;
    onCancel: () => void;
    onPreview: (config: BuilderConfig) => void;
  };
  let { owner, initialKind = null, initialObject = null, onCancel, onPreview }: Props = $props();

  let endpointType = $state<EndpointType>(
    initialKind === "procedure" || initialKind === "function" ? "procedure"
    : initialKind === "table" || initialKind === "view" ? "auto-crud"
    : "auto-crud"
  );
  let sourceObject = $state<{ owner: string; name: string; kind: string } | null>(
    initialObject ? { ...initialObject, kind: (initialKind ?? "TABLE").toUpperCase() } : null
  );
  let sourceSql = $state("SELECT col1, col2 FROM tabela WHERE id = :id");
  let operations = $state<string[]>(["GET", "POST", "PUT", "DELETE", "GET_BY_ID"]);
  let moduleMode = $state<"new" | "existing">("new");
  let moduleName = $state("");
  let basePath = $state("/");
  let routePattern = $state("/");
  let method = $state("GET");
  let authMode = $state<AuthMode>("none");
  let authRole = $state<string | null>(null);

  let tablesList = $state<{ name: string }[]>([]);
  let viewsList = $state<{ name: string }[]>([]);
  let proceduresList = $state<{ name: string }[]>([]);
  let functionsList = $state<{ name: string }[]>([]);
  let rolesList = $state<string[]>([]);

  let selectedObjectKey = $state(
    initialObject ? `${(initialKind ?? "TABLE").toUpperCase()}:${initialObject.name}` : ""
  );

  let showSheepOverlay = $state(false);
  let sheepDescription = $state("");
  let sheepLoading = $state(false);
  let sheepError = $state<string | null>(null);
  let sheepSuggestion = $state<AiEndpointSuggestion | null>(null);

  async function requestSuggestion() {
    if (!sheepDescription.trim()) return;
    sheepLoading = true;
    sheepError = null;
    try {
      const apiKey = await aiKeyGet("anthropic");
      const res = await aiSuggestEndpoint({
        apiKey,
        description: sheepDescription.trim(),
        schemaName: owner,
        availableTables: tablesList.map((t) => t.name),
        availableViews: viewsList.map((v) => v.name),
        availableProcedures: proceduresList.map((p) => p.name),
        availableFunctions: functionsList.map((f) => f.name),
      });
      if (res.ok) sheepSuggestion = res.data.suggestion;
      else sheepError = res.error.message;
    } catch (e) {
      sheepError = e instanceof Error ? e.message : String(e);
    } finally {
      sheepLoading = false;
    }
  }

  function applySuggestion() {
    if (!sheepSuggestion) return;
    const s = sheepSuggestion;
    if (s.type) endpointType = s.type;
    if (s.sourceObjectName && s.sourceObjectKind) {
      sourceObject = { owner, name: s.sourceObjectName, kind: s.sourceObjectKind };
      selectedObjectKey = `${s.sourceObjectKind}:${s.sourceObjectName}`;
    }
    if (s.sourceSql) sourceSql = s.sourceSql;
    if (s.routePattern) routePattern = s.routePattern;
    if (s.method) method = s.method;
    if (s.moduleName) moduleName = s.moduleName;
    if (s.basePath) basePath = s.basePath;
    if (s.authMode) authMode = s.authMode;

    if (endpointType === "auto-crud" && tablesList.length === 0 && viewsList.length === 0) void loadTablesViews();
    if (endpointType === "procedure" && proceduresList.length === 0 && functionsList.length === 0) void loadProcsFuncs();

    showSheepOverlay = false;
    sheepDescription = "";
    sheepSuggestion = null;
  }

  $effect(() => {
    if (endpointType === "auto-crud" && tablesList.length === 0 && viewsList.length === 0) {
      void loadTablesViews();
    }
    if (endpointType === "procedure" && proceduresList.length === 0 && functionsList.length === 0) {
      void loadProcsFuncs();
    }
  });

  $effect(() => {
    if (authMode === "role" && rolesList.length === 0) {
      void ordsRolesList().then((r) => { if (r.ok) rolesList = r.data.roles; });
    }
  });

  $effect(() => {
    if (sourceObject && moduleMode === "new" && !moduleName) {
      const slug = sourceObject.name.toLowerCase().replace(/_/g, "-");
      moduleName = `${slug}-api`;
      basePath = `/${slug}/`;
    }
  });

  async function loadTablesViews() {
    const [t, v] = await Promise.all([
      objectsList(owner, "TABLE"),
      objectsList(owner, "VIEW"),
    ]);
    if (t.ok) tablesList = t.data;
    if (v.ok) viewsList = v.data;
  }

  async function loadProcsFuncs() {
    const [p, f] = await Promise.all([
      objectsListPlsql(owner, "PROCEDURE"),
      objectsListPlsql(owner, "FUNCTION"),
    ]);
    if (p.ok) proceduresList = p.data;
    if (f.ok) functionsList = f.data;
  }

  function onObjectChange() {
    if (!selectedObjectKey) return;
    const [k, n] = selectedObjectKey.split(":");
    sourceObject = { owner, name: n, kind: k };
  }

  const detectedBinds = $derived(
    endpointType === "custom-sql"
      ? Array.from(new Set([...sourceSql.matchAll(/:(\w+)/g)].map((m) => m[1])))
      : []
  );

  const detectedPathParams = $derived(
    Array.from(new Set([...routePattern.matchAll(/:(\w+)/g)].map((m) => m[1])))
  );

  function toggleOperation(op: string) {
    operations = operations.includes(op)
      ? operations.filter((o) => o !== op)
      : [...operations, op];
  }

  function handlePreview() {
    onPreview({
      type: endpointType,
      sourceObject,
      sourceSql: endpointType === "custom-sql" ? sourceSql : null,
      operations,
      moduleMode,
      moduleName,
      basePath,
      routePattern,
      method,
      authMode,
      authRole,
    });
  }

  const previewUrls = $derived.by(() => {
    if (endpointType !== "auto-crud" || !sourceObject) return [];
    const out: { method: string; path: string; label: string }[] = [];
    if (operations.includes("GET")) out.push({ method: "GET", path: basePath, label: "lista" });
    if (operations.includes("GET_BY_ID")) out.push({ method: "GET", path: basePath + ":id/", label: "detalhe" });
    if (operations.includes("POST")) out.push({ method: "POST", path: basePath, label: "create" });
    if (operations.includes("PUT")) out.push({ method: "PUT", path: basePath + ":id/", label: "update" });
    if (operations.includes("DELETE")) out.push({ method: "DELETE", path: basePath + ":id/", label: "remover" });
    return out;
  });
</script>

<div
  class="modal-backdrop"
  onclick={onCancel}
  onkeydown={(e) => e.key === "Escape" && onCancel()}
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
    <div class="modal-head">
      <span class="title">Create REST Endpoint</span>
      <div class="head-actions">
        <button class="sheep-btn" onclick={() => showSheepOverlay = true} title="Descrever em linguagem natural">✨ Sheep</button>
        <button class="close-btn" onclick={onCancel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="modal-body">
      {#if showSheepOverlay}
        <div class="sheep-overlay">
          <div class="sheep-card">
            <div class="sheep-head">
              <img src="/veesker-sheep.png" class="sheep-icon" alt="" />
              <span>Descreva o endpoint que você quer:</span>
              <button class="close-x" onclick={() => showSheepOverlay = false} aria-label="Close">✕</button>
            </div>
            <textarea
              class="sheep-input"
              bind:value={sheepDescription}
              rows="3"
              placeholder="ex: API que lista funcionários ativos do departamento X..."
            ></textarea>
            {#if sheepError}<div class="sheep-error">{sheepError}</div>{/if}
            {#if sheepSuggestion}
              <div class="sheep-suggestion">
                <strong>Sugestão:</strong> {sheepSuggestion.reasoning ?? ""}
                <pre class="suggestion-json">{JSON.stringify(sheepSuggestion, null, 2)}</pre>
                <div class="sheep-actions">
                  <button class="btn" onclick={() => { sheepSuggestion = null; }}>Tentar de novo</button>
                  <button class="btn primary" onclick={applySuggestion}>Aplicar ao form</button>
                </div>
              </div>
            {:else}
              <div class="sheep-actions">
                <button class="btn" onclick={() => showSheepOverlay = false}>Cancel</button>
                <button
                  class="btn primary"
                  onclick={() => void requestSuggestion()}
                  disabled={sheepLoading || !sheepDescription.trim()}
                >
                  {sheepLoading ? "Pensando…" : "Enviar"}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
      <div class="row">
        <span class="label">Tipo:</span>
        <label class="radio"><input type="radio" bind:group={endpointType} value="auto-crud" /> Auto-CRUD</label>
        <label class="radio"><input type="radio" bind:group={endpointType} value="custom-sql" /> Custom SQL</label>
        <label class="radio"><input type="radio" bind:group={endpointType} value="procedure" /> Procedure/Function</label>
      </div>

      <div class="section">
        <h3>Source</h3>

        {#if endpointType === "auto-crud"}
          <div class="row">
            <span class="label">Tabela/View:</span>
            <select class="input" bind:value={selectedObjectKey} onchange={onObjectChange}>
              <option value="" disabled>Selecione…</option>
              <optgroup label="Tables">
                {#each tablesList as t (t.name)}<option value={"TABLE:" + t.name}>{t.name}</option>{/each}
              </optgroup>
              <optgroup label="Views">
                {#each viewsList as v (v.name)}<option value={"VIEW:" + v.name}>{v.name}</option>{/each}
              </optgroup>
            </select>
          </div>
          <div class="row">
            <span class="label">Operações:</span>
            <div class="ops">
              {#each ["GET", "POST", "PUT", "DELETE", "GET_BY_ID"] as op}
                <label class="op-cb">
                  <input
                    type="checkbox"
                    checked={operations.includes(op)}
                    onchange={() => toggleOperation(op)}
                  />
                  {op}
                </label>
              {/each}
            </div>
          </div>
        {/if}

        {#if endpointType === "custom-sql"}
          <div class="row">
            <span class="label">SQL:</span>
          </div>
          <textarea
            class="sql-area"
            bind:value={sourceSql}
            rows="6"
            placeholder="SELECT col1, col2 FROM tabela WHERE id = :id"
          ></textarea>
          <div class="row">
            <span class="label">Rota:</span>
            <input class="input" bind:value={routePattern} placeholder="/by-id/:id" />
            <span class="label" style="min-width: 60px">Método:</span>
            <select class="input" bind:value={method} style="flex: 0 0 100px">
              <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
            </select>
          </div>
          <div class="hint">
            Bind variables no SQL: {detectedBinds.join(", ") || "(nenhuma)"}
          </div>
          <div class="hint">
            Path params na rota: {detectedPathParams.join(", ") || "(nenhum)"}
          </div>
        {/if}

        {#if endpointType === "procedure"}
          <div class="row">
            <span class="label">Objeto:</span>
            <select class="input" bind:value={selectedObjectKey} onchange={onObjectChange}>
              <option value="" disabled>Selecione…</option>
              <optgroup label="Procedures">
                {#each proceduresList as p (p.name)}<option value={"PROCEDURE:" + p.name}>{p.name}</option>{/each}
              </optgroup>
              <optgroup label="Functions">
                {#each functionsList as f (f.name)}<option value={"FUNCTION:" + f.name}>{f.name}</option>{/each}
              </optgroup>
            </select>
          </div>
          <div class="row">
            <span class="label">Rota:</span>
            <input class="input" bind:value={routePattern} placeholder="/" />
            <span class="label" style="min-width: 60px">Método:</span>
            <select class="input" bind:value={method} style="flex: 0 0 100px">
              <option>POST</option><option>GET</option><option>PUT</option><option>DELETE</option>
            </select>
          </div>
          <div class="hint">
            Os parâmetros IN da procedure/function virão do {method === "GET" ? "query string" : "body JSON"}.
            OUT params e SYS_REFCURSOR vão para o response JSON.
          </div>
        {/if}
      </div>

      <div class="section">
        <h3>Roteamento</h3>
        <div class="row">
          <label class="radio"><input type="radio" bind:group={moduleMode} value="new" /> New module:</label>
          <input class="input" bind:value={moduleName} placeholder="meu-modulo" disabled={moduleMode !== "new"} />
        </div>
        <div class="row">
          <label class="radio"><input type="radio" bind:group={moduleMode} value="existing" /> Módulo existente</label>
        </div>
        <div class="row">
          <span class="label">Base path:</span>
          <input class="input" bind:value={basePath} placeholder="/api/" />
        </div>
      </div>

      <div class="section">
        <h3>Auth</h3>
        <div class="row"><label class="radio"><input type="radio" bind:group={authMode} value="none" /> Público (sem auth)</label></div>
        <div class="row"><label class="radio"><input type="radio" bind:group={authMode} value="role" /> Role do banco</label></div>
        {#if authMode === "role"}
          <div class="row" style="margin-left: 22px">
            <span class="label">Role:</span>
            <select class="input" bind:value={authRole}>
              <option value={null} disabled>Selecione…</option>
              {#each rolesList as r (r)}<option value={r}>{r}</option>{/each}
            </select>
          </div>
        {/if}
        <div class="row"><label class="radio"><input type="radio" bind:group={authMode} value="oauth" /> OAuth 2.0 Client Credentials</label></div>
        {#if authMode === "oauth"}
          <div class="hint" style="margin-left: 22px">
            Veesker will create the privilege automatically. Create OAuth clients in the "API Clients" section.
          </div>
        {/if}
      </div>

      {#if endpointType === "auto-crud" && sourceObject && previewUrls.length > 0}
        <div class="section">
          <h3>Preview da URL</h3>
          <div class="urls">
            {#each previewUrls as u}
              <div class="url-row">
                <span class="method method-{u.method.toLowerCase()}">{u.method}</span>
                <code class="url-path">{u.path}</code>
                <span class="url-label">({u.label})</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-foot">
      <button class="btn" onclick={onCancel}>Cancel</button>
      <button
        class="btn primary"
        onclick={handlePreview}
        disabled={!sourceObject && endpointType !== "custom-sql"}
      >Visualizar SQL →</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px;
    width: 720px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;
    position: relative;
  }
  .modal-head { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .title { font-weight: 600; color: var(--text-primary); }
  .head-actions { display: flex; gap: 8px; }
  .sheep-btn {
    background: rgba(179,62,31,0.15); border: 1px solid rgba(179,62,31,0.4);
    color: #f5a08a; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
  }
  .sheep-btn:disabled { opacity: 0.45; cursor: default; }
  .close-btn {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; padding: 4px 8px; font-size: 14px;
  }
  .close-btn:hover { color: var(--text-primary); }
  .modal-body { padding: 16px; overflow-y: auto; flex: 1; color: var(--text-primary); font-size: 12px; position: relative; }
  .section { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .section h3 {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-muted); margin: 0 0 8px;
  }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  .label { color: var(--text-muted); min-width: 80px; font-size: 11.5px; }
  .radio { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; }
  .input {
    background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-primary); padding: 4px 8px; font-size: 11.5px; flex: 1; min-width: 0;
  }
  .ops { display: flex; gap: 10px; flex-wrap: wrap; flex: 1; }
  .op-cb { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
  .sql-area {
    width: 100%; box-sizing: border-box;
    background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-primary); padding: 8px;
    font-family: "JetBrains Mono", monospace; font-size: 11px;
    resize: vertical; min-height: 80px;
  }
  .hint { font-size: 10.5px; color: var(--text-muted); margin: 4px 0; }
  .urls { display: flex; flex-direction: column; gap: 4px; }
  .url-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .method {
    font-family: monospace; font-weight: 700; padding: 1px 6px;
    border-radius: 3px; font-size: 10px; min-width: 56px; text-align: center;
  }
  .method-get { background: rgba(74,158,218,0.2); color: #4a9eda; }
  .method-post { background: rgba(139,196,168,0.2); color: #8bc4a8; }
  .method-put { background: rgba(195,166,110,0.2); color: #c3a66e; }
  .method-delete { background: rgba(245,160,138,0.2); color: #f5a08a; }
  .url-path { font-family: monospace; font-size: 10.5px; }
  .url-label { color: var(--text-muted); font-size: 10.5px; }
  .modal-foot {
    padding: 10px 16px; border-top: 1px solid var(--border);
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .btn {
    background: var(--bg-surface-alt); border: 1px solid var(--border);
    color: var(--text-primary); padding: 5px 12px; border-radius: 4px;
    cursor: pointer; font-size: 11.5px;
  }
  .btn:hover:not(:disabled) { background: var(--row-hover); }
  .btn.primary {
    background: rgba(179,62,31,0.2); border-color: rgba(179,62,31,0.45);
    color: #f5a08a;
  }
  .btn.primary:hover:not(:disabled) { background: rgba(179,62,31,0.35); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .sheep-overlay {
    position: absolute; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 60px; z-index: 10;
  }
  .sheep-card {
    background: var(--bg-surface); border: 1px solid rgba(179,62,31,0.5);
    border-radius: 8px; padding: 16px; width: 90%; max-width: 600px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  }
  .sheep-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .sheep-head span { flex: 1; font-weight: 600; color: var(--text-primary); }
  .sheep-icon { width: 22px; height: 22px; object-fit: contain; }
  .close-x { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 6px; }
  .sheep-input {
    width: 100%; box-sizing: border-box;
    background: var(--input-bg); border: 1px solid var(--border);
    color: var(--text-primary); padding: 8px; border-radius: 4px;
    font-family: "Inter", sans-serif; font-size: 12px; resize: vertical;
  }
  .sheep-error {
    background: rgba(179,62,31,0.15); border: 1px solid rgba(179,62,31,0.3);
    color: #f5a08a; padding: 6px 8px; border-radius: 4px;
    font-size: 11px; margin-top: 8px;
  }
  .sheep-suggestion { margin-top: 12px; }
  .sheep-suggestion strong { color: var(--text-primary); }
  .suggestion-json {
    background: var(--bg-page); border: 1px solid var(--border);
    border-radius: 4px; padding: 8px; font-family: monospace; font-size: 10.5px;
    max-height: 200px; overflow: auto; margin: 8px 0;
  }
  .sheep-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
</style>
