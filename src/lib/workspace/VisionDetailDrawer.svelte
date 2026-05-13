<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Proprietary — Veesker Cloud Edition
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { objectVersionList, objectVersionDiff, type ObjectVersionEntry } from "$lib/object-versions";
  import type { VisionNode } from "$lib/workspace";

  type Props = {
    node: VisionNode;
    connectionId: string;
    onClose: () => void;
    onExplore: (node: VisionNode) => void;
  };
  const { node, connectionId, onClose, onExplore }: Props = $props();

  type DrawerTab = "ddl" | "versions" | "errors" | "audit";
  let activeTab = $state<DrawerTab>("ddl");
  let drawerHeight = $state(300);
  let isDragging = false;
  let dragStartY = 0;
  let dragStartH = 0;

  let ddl = $state<string | null>(null);
  let ddlLoading = $state(false);
  let ddlError = $state<string | null>(null);

  let versions = $state<ObjectVersionEntry[] | null>(null);
  let versionsLoading = $state(false);
  let selectedVersionId = $state<number | null>(null);
  let versionDiff = $state<string | null>(null);
  let versionFilter = $state("");

  // Smart filter for the versions list. Matches against SHA prefix, label
  // substring, captureReason, formatted date, and recognises a small DSL:
  //   today | hoje                 → captured today
  //   yesterday | ontem             → captured yesterday
  //   week | semana                 → captured in the last 7 days
  //   baseline | compile            → matches captureReason
  //   >YYYY-MM-DD or >DD/MM         → captured strictly after
  //   <YYYY-MM-DD or <DD/MM         → captured strictly before
  //   anything else                 → substring match in sha + label
  function parseDateInput(s: string): Date | null {
    const t = s.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(t + "T00:00:00");
    const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(t);
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]) - 1;
      const year = m[3] ? Number(m[3]) : new Date().getFullYear();
      return new Date(year, month, day);
    }
    return null;
  }

  function matchesVersion(v: ObjectVersionEntry, raw: string): boolean {
    const q = raw.trim().toLowerCase();
    if (!q) return true;
    const captured = new Date(v.capturedAt);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const startOfWeek = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);

    if (q === "today" || q === "hoje") return captured >= startOfToday;
    if (q === "yesterday" || q === "ontem")
      return captured >= startOfYesterday && captured < startOfToday;
    if (q === "week" || q === "semana" || q === "this week") return captured >= startOfWeek;
    if (q === "baseline" || q === "compile") return v.captureReason === q;

    if (q.startsWith(">") || q.startsWith("<")) {
      const d = parseDateInput(q.slice(1));
      if (d) return q.startsWith(">") ? captured > d : captured < d;
    }

    const haystack = `${v.commitSha} ${v.label ?? ""} ${v.captureReason} ${captured.toLocaleString()}`.toLowerCase();
    return haystack.includes(q);
  }

  const filteredVersions = $derived.by(() => {
    if (versions === null) return null;
    if (!versionFilter.trim()) return versions;
    return versions.filter((v) => matchesVersion(v, versionFilter));
  });

  type CompileError = { line: number; col: number; text: string; attribute: string };
  let errors = $state<CompileError[] | null>(null);
  let errorsLoading = $state(false);

  type AuditEntry = { occurredAt: string; sql: string; success: boolean; elapsedMs: number };
  let auditEntries = $state<AuditEntry[] | null>(null);
  let auditLoading = $state(false);
  let auditError = $state<string | null>(null);

  onMount(() => { loadDdl(); });

  $effect(() => {
    // biome-ignore lint/correctness/noUnusedVariables: reactive trigger
    const _n = node.id;
    activeTab = "ddl";
    ddl = null; ddlError = null; versions = null; errors = null; auditEntries = null; versionDiff = null;
    versionFilter = "";
    loadDdl();
  });

  $effect(() => {
    if (activeTab === "versions" && versions === null && !versionsLoading) loadVersions();
    if (activeTab === "errors" && errors === null && !errorsLoading) loadErrors();
    if (activeTab === "audit" && auditEntries === null && !auditLoading) loadAudit();
  });

  async function loadDdl() {
    ddlLoading = true; ddlError = null;
    try {
      const res = await invoke<{ ddl: string }>("object_ddl_get", {
        connectionId, owner: node.owner, objectType: node.type, objectName: node.name,
      });
      ddl = res.ddl;
    } catch (e) { ddlError = String(e); }
    ddlLoading = false;
  }

  async function loadVersions() {
    versionsLoading = true;
    try {
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000));
      const res = await Promise.race([
        objectVersionList(connectionId, node.owner, node.type, node.name),
        timeout,
      ]);
      versions = res.ok ? res.data : [];
    } catch {
      versions = [];
    }
    versionsLoading = false;
  }

  async function loadErrors() {
    errorsLoading = true;
    try {
      errors = await invoke<CompileError[]>("compile_errors_get", {
        connectionId, owner: node.owner, objectType: node.type, objectName: node.name,
      });
    } catch { errors = []; }
    errorsLoading = false;
  }

  async function loadAudit() {
    auditLoading = true; auditError = null;
    try {
      const res = await invoke<{ entries: AuditEntry[] }>("cloud_api_get", {
        path: "/v1/audit",
        params: { object: node.name, limit: "20" },
      });
      auditEntries = res.entries ?? [];
    } catch (e) {
      auditEntries = [];
      const msg = String(e);
      auditError = msg.includes("not_authenticated")
        ? "Connect to Veesker Cloud to view execution history."
        : `Failed to load: ${msg}`;
    }
    auditLoading = false;
  }

  async function loadDiff(v: ObjectVersionEntry) {
    if (versions === null || versions.length < 2) return;
    const idx = versions.indexOf(v);
    if (idx === versions.length - 1) return;
    versionDiff = null;
    const res = await objectVersionDiff(
      connectionId,
      versions[idx + 1].commitSha, v.commitSha,
      `${node.owner}/${node.type}/${node.name}.sql`
    );
    if (res.ok) versionDiff = res.data;
  }

  function onDragStart(e: MouseEvent) {
    isDragging = true; dragStartY = e.clientY; dragStartH = drawerHeight;
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  }
  function onDragMove(e: MouseEvent) {
    if (!isDragging) return;
    drawerHeight = Math.max(120, Math.min(600, dragStartH + (dragStartY - e.clientY)));
  }
  function onDragEnd() {
    isDragging = false;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }

  const TYPE_BADGE: Record<string, string> = {
    TABLE: "TBL", VIEW: "VIEW", PROCEDURE: "PROC", FUNCTION: "FN",
    PACKAGE: "PKG", "PACKAGE BODY": "PKG", TRIGGER: "TRG", SEQUENCE: "SEQ",
  };

  const TABS: { id: DrawerTab; label: string }[] = [
    { id: "ddl", label: "DDL" },
    { id: "versions", label: "Versions" },
    { id: "errors", label: "Errors" },
    { id: "audit", label: "Audit" },
  ];

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const PLSQL_KW = new Set([
    "CREATE","OR","REPLACE","PROCEDURE","FUNCTION","PACKAGE","BODY","TRIGGER",
    "VIEW","TABLE","INDEX","SEQUENCE","TYPE","SYNONYM","DIRECTORY",
    "BEGIN","END","IS","AS","DECLARE","RETURN",
    "IF","ELSIF","ELSE","THEN","LOOP","WHILE","FOR","IN","OUT","NOCOPY",
    "EXIT","WHEN","EXCEPTION","RAISE",
    "SELECT","INSERT","UPDATE","DELETE","MERGE","TRUNCATE","DROP","ALTER",
    "FROM","WHERE","AND","NOT","NULL","INTO","VALUES","SET",
    "JOIN","ON","LEFT","RIGHT","INNER","OUTER","FULL","CROSS",
    "UNION","ALL","DISTINCT","GROUP","BY","ORDER","HAVING","ASC","DESC",
    "FETCH","NEXT","ROWS","ONLY","WITH","CONNECT","START","PRIOR",
    "CASE","BULK","COLLECT","FORALL","EXECUTE","IMMEDIATE",
    "OPEN","CLOSE","CURSOR","PRAGMA","AUTHID","CURRENT_USER","DEFINER",
    "COMMIT","ROLLBACK","SAVEPOINT","GRANT","REVOKE","TO","PUBLIC",
    "TRUE","FALSE","BETWEEN","LIKE","EXISTS","ANY",
  ]);

  const PLSQL_TYPE = new Set([
    "VARCHAR2","VARCHAR","CHAR","NVARCHAR2","NCHAR","CLOB","NCLOB","BLOB","BFILE",
    "NUMBER","INTEGER","INT","SMALLINT","FLOAT","REAL","DECIMAL","NUMERIC",
    "BINARY_INTEGER","PLS_INTEGER","SIMPLE_INTEGER","BINARY_FLOAT","BINARY_DOUBLE",
    "DATE","TIMESTAMP","INTERVAL","BOOLEAN","RAW","LONG","XMLTYPE",
    "ROWID","UROWID","ROWTYPE","RECORD","VARRAY","OBJECT","SYS_REFCURSOR",
  ]);

  function highlightPlsql(code: string): string {
    const out: string[] = [];
    let i = 0;
    const len = code.length;
    while (i < len) {
      if (code[i] === "-" && code[i + 1] === "-") {
        const nl = code.indexOf("\n", i);
        const tok = nl === -1 ? code.slice(i) : code.slice(i, nl + 1);
        out.push(`<span class="plsql-comment">${esc(tok)}</span>`);
        i += tok.length;
      } else if (code[i] === "/" && code[i + 1] === "*") {
        const cl = code.indexOf("*/", i + 2);
        const tok = cl === -1 ? code.slice(i) : code.slice(i, cl + 2);
        out.push(`<span class="plsql-comment">${esc(tok)}</span>`);
        i += tok.length;
      } else if (code[i] === "'") {
        let j = i + 1;
        while (j < len) {
          if (code[j] === "'") { if (code[j + 1] === "'") { j += 2; continue; } j++; break; }
          j++;
        }
        out.push(`<span class="plsql-string">${esc(code.slice(i, j))}</span>`);
        i = j;
      } else if (/[0-9]/.test(code[i])) {
        let j = i;
        while (j < len && /[0-9.eExX]/.test(code[j])) j++;
        out.push(`<span class="plsql-num">${esc(code.slice(i, j))}</span>`);
        i = j;
      } else if (/[a-zA-Z_$#]/.test(code[i])) {
        let j = i;
        while (j < len && /[a-zA-Z0-9_$#]/.test(code[j])) j++;
        const word = code.slice(i, j);
        const up = word.toUpperCase();
        if (PLSQL_KW.has(up)) out.push(`<span class="plsql-kw">${esc(word)}</span>`);
        else if (PLSQL_TYPE.has(up)) out.push(`<span class="plsql-type">${esc(word)}</span>`);
        else out.push(esc(word));
        i = j;
      } else {
        out.push(esc(code[i]));
        i++;
      }
    }
    return out.join("");
  }
</script>

<div class="vision-drawer" style="height: {drawerHeight}px">
  <div class="drag-handle" onmousedown={onDragStart} role="separator" aria-orientation="horizontal"></div>

  <div class="drawer-header">
    <span class="type-badge">{TYPE_BADGE[node.type?.toUpperCase()] ?? node.type}</span>
    <span class="obj-owner">{node.owner}.</span><span class="obj-name">{node.name}</span>
    <span class="status-badge" class:invalid={node.status === "INVALID"}>{node.status}</span>
    <button class="explore-btn" onclick={() => onExplore(node)}>Explore ↗</button>
    <button class="close-btn" onclick={onClose} aria-label="Close">×</button>
  </div>

  <div class="drawer-tabs">
    {#each TABS as tab}
      <button class="dtab" class:active={activeTab === tab.id} onclick={() => activeTab = tab.id}>
        {tab.label}
        {#if tab.id === "errors" && errors !== null && errors.length > 0}
          <span class="err-count">{errors.length}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="drawer-body">
    {#if activeTab === "ddl"}
      {#if ddlLoading}<div class="loading">Loading DDL…</div>
      {:else if ddlError}<div class="err-msg">{ddlError}</div>
      {:else if ddl}<pre class="ddl-code">{@html highlightPlsql(ddl)}</pre>
      {:else}<div class="empty">No DDL available.</div>{/if}

    {:else if activeTab === "versions"}
      {#if versionsLoading || versions === null}<div class="loading">Loading versions…</div>
      {:else if versions.length === 0}<div class="empty">No versions captured yet.</div>
      {:else}
        <div class="version-filter">
          <div class="vf-input-wrap">
            <svg class="vf-search-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.4"/>
              <path d="M9.2 9.2l3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
            <input
              type="text"
              class="vf-input"
              placeholder="sha · label · today · week · baseline · >2026-04-28"
              bind:value={versionFilter}
              autocomplete="off"
              spellcheck="false"
            />
            {#if versionFilter}
              <button class="vf-clear" title="Clear" onclick={() => versionFilter = ""}>×</button>
            {/if}
          </div>
          <div class="vf-chips">
            <button class="vf-chip" class:on={versionFilter === "today"} onclick={() => versionFilter = versionFilter === "today" ? "" : "today"}>Today</button>
            <button class="vf-chip" class:on={versionFilter === "week"} onclick={() => versionFilter = versionFilter === "week" ? "" : "week"}>Week</button>
            <button class="vf-chip" class:on={versionFilter === "baseline"} onclick={() => versionFilter = versionFilter === "baseline" ? "" : "baseline"}>Baseline</button>
            <button class="vf-chip" class:on={versionFilter === "compile"} onclick={() => versionFilter = versionFilter === "compile" ? "" : "compile"}>Compile</button>
          </div>
          {#if versionFilter}
            <span class="vf-count">{filteredVersions?.length ?? 0} of {versions.length}</span>
          {/if}
        </div>
        {#if filteredVersions && filteredVersions.length === 0}
          <div class="empty">No versions match the filter.</div>
        {:else}
        <div class="version-list">
          {#each filteredVersions ?? [] as v}
            <button class="version-row" class:selected={selectedVersionId === v.id}
              onclick={() => { selectedVersionId = v.id; void loadDiff(v); }}>
              <span class="sha">{v.commitSha.slice(0, 7)}</span>
              <span class="label">{v.label ?? "—"}</span>
              <span class="ts">{new Date(v.capturedAt).toLocaleString()}</span>
            </button>
          {/each}
        </div>
        {/if}
        {#if versionDiff}
          <div class="diff-viewer">
            {#each versionDiff.split("\n") as line}
              {@const cls = line.startsWith("+++") || line.startsWith("---") ? "diff-meta"
                : line.startsWith("+") ? "diff-add"
                : line.startsWith("-") ? "diff-del"
                : line.startsWith("@@") ? "diff-hunk"
                : line.startsWith("diff ") || line.startsWith("index ") ? "diff-header"
                : "diff-ctx"}
              <div class={cls}>{line || " "}</div>
            {/each}
          </div>
        {/if}
      {/if}

    {:else if activeTab === "errors"}
      {#if errorsLoading || errors === null}<div class="loading">Loading…</div>
      {:else if errors.length === 0}<div class="empty">No compile errors.</div>
      {:else}
        <table class="data-table">
          <thead><tr><th>Line</th><th>Col</th><th>Message</th></tr></thead>
          <tbody>
            {#each errors as e}
              <tr><td>{e.line}</td><td>{e.col}</td><td>{e.text}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}

    {:else if activeTab === "audit"}
      {#if auditLoading || auditEntries === null}<div class="loading">Loading audit…</div>
      {:else if auditError}<div class="err-msg">{auditError}</div>
      {:else if auditEntries.length === 0}<div class="empty">No executions recorded for this object.</div>
      {:else}
        <table class="data-table">
          <thead><tr><th>When</th><th>SQL</th><th>Result</th><th>ms</th></tr></thead>
          <tbody>
            {#each auditEntries as e}
              <tr>
                <td class="nowrap">{new Date(e.occurredAt).toLocaleString()}</td>
                <td class="sql-cell" title={e.sql ?? ""}>{(e.sql ?? "").slice(0, 80)}{(e.sql ?? "").length > 80 ? "…" : ""}</td>
                <td><span class="result-badge" class:fail={!e.success}>{e.success ? "OK" : "FAIL"}</span></td>
                <td>{e.elapsedMs}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  </div>
</div>

<style>
.vision-drawer {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: var(--bg-surface); border-top: 1px solid var(--border);
  display: flex; flex-direction: column; z-index: 10;
}
.drag-handle {
  height: 4px; background: transparent; cursor: ns-resize;
  border-top: 2px solid var(--border);
  flex-shrink: 0;
}
.drag-handle:hover { background: var(--border); }
.drawer-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.type-badge { background: #1a3a6e; color: #7eb3ff; font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 700; }
.obj-owner { color: var(--text-muted); font-size: 13px; }
.obj-name { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.status-badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #1a3a1a; color: #3fb950; }
.status-badge.invalid { background: #3a1a1a; color: #e74c3c; }
.explore-btn { margin-left: auto; background: transparent; border: 1px solid var(--border); color: var(--text-muted); font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer; }
.explore-btn:hover { color: var(--text-primary); }
.close-btn { background: transparent; border: none; color: var(--text-muted); font-size: 18px; cursor: pointer; line-height: 1; padding: 0 2px; }
.drawer-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.dtab { padding: 5px 14px; font-size: 12px; color: var(--text-muted); border: none; background: transparent; border-bottom: 2px solid transparent; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.dtab.active { color: #7eb3ff; border-bottom-color: #4a9eff; }
.drawer-body { flex: 1; overflow-y: auto; }
.loading, .empty { padding: 16px; color: var(--text-muted); font-size: 12px; }
.err-msg { padding: 12px; color: #e74c3c; font-size: 12px; }
.ddl-code { font-family: monospace; font-size: 12px; padding: 12px; margin: 0; white-space: pre; color: var(--text-primary); background: var(--bg-page); overflow-x: auto; }
.diff-viewer { font-family: monospace; font-size: 12px; background: var(--bg-page); overflow-x: auto; }
.diff-viewer > div { padding: 1px 12px; white-space: pre; min-height: 18px; line-height: 18px; }
.diff-add    { background: rgba(63, 185, 80, 0.12); color: #3fb950; }
.diff-del    { background: rgba(231, 76, 60, 0.12); color: #e74c3c; }
.diff-hunk   { background: rgba(74, 158, 255, 0.10); color: #4a9eff; }
.diff-header { color: var(--text-muted); }
.diff-meta   { color: #8b949e; }
.diff-ctx    { color: var(--text-primary); }
.version-filter { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.vf-input-wrap { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 220px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; transition: border-color 0.12s; }
.vf-input-wrap:focus-within { border-color: var(--accent-border-focus, #4a9eff); }
.vf-search-icon { color: var(--text-muted); flex-shrink: 0; }
.vf-input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-family: inherit; font-size: 12px; padding: 5px 0; min-width: 0; }
.vf-input::placeholder { color: var(--text-muted); font-size: 11px; }
.vf-clear { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
.vf-clear:hover { color: var(--text-primary); }
.vf-chips { display: flex; gap: 3px; }
.vf-chip { background: transparent; border: 1px solid var(--border); color: var(--text-muted); font-size: 10px; font-weight: 600; letter-spacing: 0.04em; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-family: inherit; transition: background 0.1s, color 0.1s, border-color 0.1s; }
.vf-chip:hover { color: var(--text-primary); border-color: var(--text-muted); }
.vf-chip.on { background: rgba(74, 158, 255, 0.12); border-color: rgba(74, 158, 255, 0.4); color: #4a9eff; }
.vf-count { font-size: 10px; color: var(--text-muted); margin-left: auto; white-space: nowrap; }
.version-list { display: flex; flex-direction: column; }
.version-row { display: flex; gap: 12px; padding: 6px 12px; text-align: left; background: transparent; border: none; border-bottom: 1px solid var(--border); cursor: pointer; color: var(--text-primary); font-size: 12px; }
.version-row:hover, .version-row.selected { background: var(--bg-surface-alt); }
.sha { font-family: monospace; color: var(--text-muted); min-width: 56px; }
.ts { color: var(--text-muted); margin-left: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.data-table th, .data-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); text-align: left; color: var(--text-primary); }
.data-table th { color: var(--text-muted); font-weight: 600; background: var(--bg-surface-alt); position: sticky; top: 0; }
.sql-cell { font-family: monospace; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.result-badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #1a3a1a; color: #3fb950; }
.result-badge.fail { background: #3a1a1a; color: #e74c3c; }
.err-count { background: #e74c3c; color: #fff; font-size: 9px; padding: 0 4px; border-radius: 8px; }
:global(.plsql-kw) { color: #569cd6; font-weight: 600; }
:global(.plsql-type) { color: #4ec9b0; }
:global(.plsql-string) { color: #ce9178; }
:global(.plsql-comment) { color: #6a9955; font-style: italic; }
:global(.plsql-num) { color: #b5cea8; }
</style>
