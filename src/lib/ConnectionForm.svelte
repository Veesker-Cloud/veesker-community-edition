<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import { untrack } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    walletInspect,
    type ConnectionInput,
    type ConnectionEnv,
  } from "$lib/connections";
  import { testConnection } from "$lib/connection";
  import SecurityDisclaimerModal from "$lib/workspace/SecurityDisclaimerModal.svelte";

  type TestState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; serverVersion: string; elapsedMs: number }
    | { kind: "err"; message: string };

  type SaveState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "err"; message: string };

  type WalletPick =
    | { kind: "none" }
    | { kind: "loading"; path: string }
    | { kind: "ready"; path: string; aliases: string[] }
    | { kind: "err"; path: string; message: string };

  let {
    initial,
    submitLabel = "Save",
    passwordMissing = false,
    walletPasswordMissing = false,
    isEdit = false,
    onSave,
    onCancel,
  }: {
    initial: ConnectionInput;
    submitLabel?: string;
    passwordMissing?: boolean;
    walletPasswordMissing?: boolean;
    isEdit?: boolean;
    onSave: (input: ConnectionInput) => Promise<{ ok: true; id: string } | { ok: false; message: string }>;
    onCancel: () => void;
  } = $props();

  let authType = $state<"basic" | "wallet">(untrack(() => initial.authType));
  let id = $state<string | undefined>(untrack(() => initial.id));
  let name = $state(untrack(() => initial.name));
  let username = $state(untrack(() => initial.username));
  let password = $state(untrack(() => initial.password));

  let host = $state(untrack(() => initial.authType === "basic" ? initial.host : "localhost"));
  let port = $state(untrack(() => initial.authType === "basic" ? initial.port : 1521));
  let serviceName = $state(untrack(() => initial.authType === "basic" ? initial.serviceName : "FREEPDB1"));

  let walletPassword = $state(untrack(() => initial.authType === "wallet" ? initial.walletPassword : ""));
  let connectAlias = $state(untrack(() => initial.authType === "wallet" ? initial.connectAlias : ""));

  // Safety fields — default to permissive so existing UX is unchanged
  let env = $state<ConnectionEnv | "">(untrack(() => initial.safety?.env ?? ""));
  let readOnly = $state<boolean>(untrack(() => initial.safety?.readOnly ?? false));
  let statementTimeoutSec = $state<string>(untrack(() => {
    const ms = initial.safety?.statementTimeoutMs;
    return ms !== undefined && ms > 0 ? String(Math.round(ms / 1000)) : "";
  }));
  let warnUnsafeDml = $state<boolean>(untrack(() => initial.safety?.warnUnsafeDml ?? false));
  let autoPerfAnalysis = $state<boolean>(untrack(() => initial.safety?.autoPerfAnalysis ?? true));
  // L1.2 air-gap toggle — explicit user choice when set; undefined falls
  // through to Rust's prod-default policy on save.
  let airgapMode = $state<boolean>(untrack(() => initial.safety?.airgapMode ?? false));
  let airgapTouched = $state<boolean>(untrack(() => initial.safety?.airgapMode !== undefined));
  // L2.1 PSDPM toggle — when the persisted row has no explicit value yet, the
  // displayed default mirrors the backend env-derived rule (prod/staging on,
  // else off) so the form preview matches what the backend would persist.
  let psdpmMode = $state<boolean>(untrack(() => {
    const explicit = initial.safety?.psdpmMode;
    if (typeof explicit === "boolean") return explicit;
    const e = initial.safety?.env;
    return e === "prod" || e === "staging";
  }));
  // L3.2 (Onda 3) auto-EXPLAIN mode. When the persisted row has no explicit
  // value yet, the displayed default mirrors the backend env-derived rule
  // (prod/staging → when_dml, else manual) so the form preview matches what
  // the backend would persist.
  function defaultAutoExplainMode(
    e: ConnectionEnv | undefined | null,
  ): "manual" | "always" | "when_dml" {
    if (e === "staging" || e === "prod") return "when_dml";
    return "manual";
  }
  let autoExplainMode = $state<"manual" | "always" | "when_dml">(
    untrack(() =>
      initial.safety?.autoExplainMode ??
      defaultAutoExplainMode(initial.safety?.env),
    ),
  );
  let expandedHints = $state<Set<string>>(new Set());
  function toggleHint(key: string) {
    const next = new Set(expandedHints);
    if (next.has(key)) next.delete(key); else next.add(key);
    expandedHints = next;
  }
  const effectiveAirgap = $derived(env === "prod" ? true : airgapMode);
  const effectivePsdpm = $derived(env === "prod" ? true : psdpmMode);
  const lockedCount = $derived(env === "prod" ? 2 : 0);
  const onCount = $derived(
    (env ? 1 : 0) +
    (readOnly ? 1 : 0) +
    (!!statementTimeoutSec ? 1 : 0) +
    (warnUnsafeDml ? 1 : 0) +
    (!autoPerfAnalysis ? 1 : 0) +
    (effectiveAirgap ? 1 : 0) +
    (effectivePsdpm ? 1 : 0) +
    (autoExplainMode !== "manual" ? 1 : 0),
  );
  const previewLines = $derived((() => {
    const lines: Array<{ text: string; accent?: string }> = [];
    if (env) lines.push({ text: `${env.toUpperCase()} badge on tabs`, accent: env === "prod" ? "#e05c3a" : env === "staging" ? "#e8c87e" : env === "local" ? "#3fb950" : "#6aa0f5" });
    if (readOnly) lines.push({ text: "DML/DDL blocked", accent: "#7ec96a" });
    if (warnUnsafeDml) lines.push({ text: "EXPLAIN before unsafe DML", accent: "#6acfe8" });
    if (!autoPerfAnalysis) lines.push({ text: "No background cost analysis" });
    if (effectiveAirgap) lines.push({ text: "AI + cloud outbound disabled", accent: "#f5a08a" });
    if (effectivePsdpm) lines.push({ text: "No background SQL (PSDPM)", accent: "#c48af0" });
    if (autoExplainMode !== "manual") lines.push({ text: `Auto-EXPLAIN: ${autoExplainMode === "always" ? "every statement" : "DML only"}` });
    if (statementTimeoutSec) lines.push({ text: `Timeout: ${statementTimeoutSec}s` });
    return lines;
  })());
  let showSafety = $state<boolean>(untrack(() => {
    const s = initial.safety;
    return !!(s && (s.env || s.readOnly || s.statementTimeoutMs || s.warnUnsafeDml || s.autoPerfAnalysis === false || s.airgapMode || s.psdpmMode));
  }));
  let walletPick = $state<WalletPick>(
    untrack(() =>
      initial.authType === "wallet" && isEdit
        ? { kind: "ready", path: "(saved)", aliases: [initial.connectAlias] }
        : { kind: "none" }
    )
  );

  // Untagged = editing an existing connection whose env was never set.
  const isUntagged = $derived(isEdit && !initial.safety?.env);
  const isProdUpgrade = $derived(
    isEdit && !!initial.safety?.env && initial.safety.env !== "prod" && env === "prod"
  );
  let prodUpgradeConfirmed = $state(false);
  const canSave = $derived(env !== "" && (!isProdUpgrade || prodUpgradeConfirmed));
  const envMismatch = $derived((() => {
    if (!env || authType !== "basic") return null;
    const h = host.toLowerCase();
    const sn = serviceName.toLowerCase();
    const looksLikeProd = ["prd", "prod", "production"].some(p => h.includes(p) || sn.includes(p));
    const looksLikeLocal = h === "localhost" || h === "127.0.0.1" || h === "::1";
    const looksLikeNonProd = ["dev", "development", "stg", "staging", "homolog", "uat", "test"].some(
      p => h.includes(p) || sn.includes(p),
    );
    if (looksLikeProd && env !== "prod")
      return `Host/service looks like PROD but env is ${env.toUpperCase()} — verify before connecting.`;
    if (looksLikeLocal && env === "prod")
      return "Host is localhost/127.0.0.1 but env is PROD — verify this is intentional.";
    if (looksLikeNonProd && env === "prod")
      return "Host/service name suggests non-production but env is PROD — verify before connecting.";
    return null;
  })());

  let testState = $state<TestState>({ kind: "idle" });
  let saveState = $state<SaveState>({ kind: "idle" });
  let showDisclaimer = $state(false);

  function needsDisclaimer(): boolean {
    if (typeof localStorage === "undefined") return false;
    if (id === undefined) return true;
    return !localStorage.getItem(`veesker.security.accepted.${id}`);
  }

  async function doSave(): Promise<void> {
    saveState = { kind: "running" };
    const res = await onSave(buildInput());
    if (res.ok) {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`veesker.security.accepted.${res.id}`, "1");
      }
      saveState = { kind: "idle" };
    } else {
      saveState = { kind: "err", message: res.message };
    }
  }

  async function pickWalletZip() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Wallet zip", extensions: ["zip"] }],
    });
    if (typeof selected !== "string") return;
    walletPick = { kind: "loading", path: selected };
    const res = await walletInspect(selected);
    if (!res.ok) {
      walletPick = { kind: "err", path: selected, message: res.error.message };
      return;
    }
    walletPick = { kind: "ready", path: selected, aliases: res.data.aliases };
    if (!res.data.aliases.includes(connectAlias)) {
      connectAlias = res.data.aliases[0] ?? "";
    }
  }

  function buildSafety() {
    const timeoutSec = Number.parseInt(statementTimeoutSec, 10);
    const statementTimeoutMs =
      Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined;
    // L1.2: send airgapMode whenever the user has either explicitly touched
    // the toggle OR is editing an existing record. For brand-new connections
    // where the user left the toggle alone, omit the field so Rust applies
    // its prod-default policy.
    return {
      env: env === "" ? undefined : env,
      readOnly,
      statementTimeoutMs,
      warnUnsafeDml,
      autoPerfAnalysis,
      airgapMode: airgapTouched || isEdit ? airgapMode : undefined,
      psdpmMode,
      autoExplainMode,
    };
  }

  function buildInput(): ConnectionInput {
    const safety = buildSafety();
    if (authType === "basic") {
      return { authType: "basic", id, name, host, port, serviceName, username, password, safety };
    }
    return {
      authType: "wallet",
      id,
      name,
      walletZipPath: walletPick.kind === "ready" && walletPick.path !== "(saved)" ? walletPick.path : undefined,
      walletPassword,
      connectAlias,
      username,
      password,
      safety,
    };
  }

  async function onTest() {
    testState = { kind: "running" };
    if (authType === "basic") {
      const res = await testConnection({
        authType: "basic",
        host,
        port,
        serviceName,
        username,
        password,
      });
      testState = res.ok
        ? { kind: "ok", serverVersion: res.data.serverVersion, elapsedMs: res.data.elapsedMs }
        : { kind: "err", message: res.error.message };
      return;
    }
    if (walletPick.kind !== "ready" || walletPick.path === "(saved)") {
      testState = { kind: "err", message: "Re-upload the wallet zip to test (we need its on-disk location)." };
      return;
    }
    testState = {
      kind: "err",
      message: "Save the connection first, then click Test (wallet must be extracted to disk).",
    };
  }

  async function onSubmit(event: Event) {
    event.preventDefault();
    if (needsDisclaimer()) {
      showDisclaimer = true;
      return;
    }
    await doSave();
  }
</script>

<form onsubmit={onSubmit}>
  {#if !isEdit}
    <div class="auth-toggle">
      <label class="radio">
        <input type="radio" bind:group={authType} value="basic" />
        Basic (host/port/service)
      </label>
      <label class="radio">
        <input type="radio" bind:group={authType} value="wallet" />
        Wallet (Autonomous DB / mTLS)
      </label>
    </div>
  {:else}
    <div class="auth-fixed">Auth: <strong>{authType === "basic" ? "Basic" : "Wallet (mTLS)"}</strong></div>
  {/if}

  {#if passwordMissing}
    <div class="banner warn">User password not in keychain — re-enter to save.</div>
  {/if}
  {#if walletPasswordMissing}
    <div class="banner warn">Wallet password not in keychain — re-enter to save.</div>
  {/if}

  <label>
    Name
    <input type="text" bind:value={name} required autocomplete="off" />
  </label>

  {#if authType === "basic"}
    <label>
      Host
      <input type="text" bind:value={host} required />
    </label>
    <div class="row">
      <label class="port">
        Port
        <input type="number" bind:value={port} min="1" max="65535" required />
      </label>
      <label class="service">
        Service name
        <input type="text" bind:value={serviceName} required />
      </label>
    </div>
  {:else}
    <div class="wallet-pick">
      <span class="wallet-label">Wallet</span>
      {#if walletPick.kind === "none"}
        <button type="button" class="ghost" onclick={pickWalletZip}>Choose wallet .zip…</button>
      {:else if walletPick.kind === "loading"}
        <span class="muted">Reading {walletPick.path}…</span>
      {:else if walletPick.kind === "ready"}
        <div class="wallet-row">
          <span class="path-mono">{walletPick.path}</span>
          <button type="button" class="ghost" onclick={pickWalletZip}>{walletPick.path === "(saved)" ? "Replace wallet…" : "Choose another…"}</button>
        </div>
      {:else}
        <div class="wallet-row">
          <span class="err">{walletPick.message}</span>
          <button type="button" class="ghost" onclick={pickWalletZip}>Try again…</button>
        </div>
      {/if}
    </div>

    <label>
      Connect alias
      <select bind:value={connectAlias} disabled={walletPick.kind !== "ready"} required>
        {#if walletPick.kind === "ready"}
          {#each walletPick.aliases as alias}
            <option value={alias}>{alias}</option>
          {/each}
        {:else}
          <option value="">Choose a wallet first…</option>
        {/if}
      </select>
    </label>

    <label>
      Wallet password
      <input type="password" bind:value={walletPassword} autocomplete="off" required />
    </label>
  {/if}

  <label>
    Username
    <input type="text" bind:value={username} autocomplete="off" required />
  </label>
  <label>
    Password
    <input type="password" bind:value={password} autocomplete="off" required />
  </label>

  <button
    type="button"
    class="safety-toggle"
    class:safety-toggle-prod={env === "prod"}
    class:safety-toggle-local={env === "local"}
    class:safety-toggle-staging={env === "staging"}
    class:safety-toggle-dev={env === "dev"}
    aria-expanded={showSafety}
    onclick={() => (showSafety = !showSafety)}
  >
    {showSafety ? "▼" : "▶"} Safety guards {#if !canSave}<span class="env-required-mark">⚠ env required</span>{/if}
    {#if onCount > 0}
      <span class="safety-summary">
        {#if env}<span class="badge badge-{env}">{env === "staging" ? "HOMOLOG" : env}</span>{/if}
        {#if readOnly}<span class="badge badge-ro">read-only</span>{/if}
        {#if statementTimeoutSec}<span class="badge">{statementTimeoutSec}s</span>{/if}
        {#if warnUnsafeDml}<span class="badge badge-warn">warn DML</span>{/if}
        {#if !autoPerfAnalysis}<span class="badge">no auto-perf</span>{/if}
        {#if effectiveAirgap}<span class="badge badge-airgap">air-gapped</span>{/if}
        {#if effectivePsdpm}<span class="badge badge-psdpm">PSDPM</span>{/if}
        {#if autoExplainMode !== "manual"}<span class="badge badge-explain">EXPLAIN: {autoExplainMode === "when_dml" ? "DML" : "always"}</span>{/if}
      </span>
    {:else}
      <span class="safety-hint">{onCount} on{lockedCount > 0 ? ` · ${lockedCount} locked` : " · all defaults"}</span>
    {/if}
  </button>

  {#if showSafety}
    <div class="safety-panel">
      <div class="sg-cols">
        <div class="sg-col">
          <div class="sg-group-label">Connection</div>
          <div class="sg-field">
            <div class="sg-field-header">
              <span class="sg-field-name">Environment <span class="env-required-mark">*</span></span>
              {#if isEdit && initial.safety?.env === "prod"}<span class="sg-immutable">⚠ IMMUTABLE</span>{/if}
            </div>
            {#if isUntagged && env === ""}
              <div class="env-untagged-warning">⚠ UNTAGGED — select an environment before connecting</div>
            {/if}
            <select bind:value={env} disabled={isEdit && initial.safety?.env === "prod"} class:env-select-prod={env === "prod"} class:env-select-local={env === "local"} class:env-select-staging={env === "staging"} class:env-select-dev={env === "dev"}>
              {#if !env}<option value="">— select environment —</option>{/if}
              {#if !isEdit || !initial.safety?.env || initial.safety.env === "dev"}<option value="dev">DEV — development / local</option>{/if}
              {#if !isEdit || !initial.safety?.env || initial.safety.env === "local"}<option value="local">LOCAL — Oracle XE / local dev</option>{/if}
              {#if !isEdit || !initial.safety?.env || initial.safety.env === "staging"}<option value="staging">HOMOLOG — staging / QA</option>{/if}
              <option value="prod">PROD — production{#if isEdit && initial.safety?.env && initial.safety.env !== "prod"} — upgrade, permanent{/if}</option>
            </select>
            {#if isEdit && initial.safety?.env === "prod"}<small>Delete and recreate this connection to change env.</small>{/if}
            {#if envMismatch}<div class="env-mismatch-warning">⚠ {envMismatch}</div>{/if}
            {#if isProdUpgrade}
              <div class="env-prod-upgrade-warning">
                ⚠ Upgrading to PROD is PERMANENT — air-gap and PSDPM will be hard-locked on this connection.
                <label class="env-prod-upgrade-confirm">
                  <input type="checkbox" bind:checked={prodUpgradeConfirmed} />
                  I understand this cannot be undone without deleting this connection
                </label>
              </div>
            {/if}
          </div>
          <div class="sg-field">
            <div class="sg-field-header"><span class="sg-field-name">Timeout (seconds)</span></div>
            <input type="number" min="0" placeholder="0 = unlimited" bind:value={statementTimeoutSec} />
          </div>
          <div class="sg-group-label" style="margin-top:0.75rem;">AI / Perf</div>
          <div class="sg-toggle-row">
            <button type="button" class="sg-tog" class:sg-on={autoPerfAnalysis} aria-pressed={autoPerfAnalysis} aria-label="Toggle auto-perf analysis" onclick={() => { autoPerfAnalysis = !autoPerfAnalysis; }}><span class="sg-knob"></span></button>
            <span class="sg-toggle-label">Auto-perf analysis</span>
            <button type="button" class="sg-hint-btn" onclick={() => toggleHint("perf")}>?</button>
          </div>
          {#if expandedHints.has("perf")}
            <div class="sg-hint-text">Background EXPLAIN PLAN + table stats to surface cost badges as you type. Turn off to silence background analysis; the "Why slow?" button still works on demand.</div>
          {/if}
          <div class="sg-field" style="margin-top:0.35rem;">
            <div class="sg-field-header"><span class="sg-field-name">📊 Auto-EXPLAIN</span></div>
            <select bind:value={autoExplainMode}>
              <option value="manual">Manual — only on F9</option>
              <option value="when_dml">When DML / staging+prod</option>
              <option value="always">Always — every statement</option>
            </select>
          </div>
        </div>
        <div class="sg-col">
          <div class="sg-group-label">Safety</div>
          <div class="sg-toggle-row">
            <button type="button" class="sg-tog" class:sg-on={readOnly} aria-pressed={readOnly} aria-label="Toggle read-only mode" onclick={() => { readOnly = !readOnly; }}><span class="sg-knob"></span></button>
            <span class="sg-toggle-label">Read-only</span>
            <button type="button" class="sg-hint-btn" onclick={() => toggleHint("ro")}>?</button>
          </div>
          {#if expandedHints.has("ro")}
            <div class="sg-hint-text">Refuse DML/DDL on this connection — SELECT, EXPLAIN, and WITH queries still work.</div>
          {/if}
          <div class="sg-toggle-row">
            <button type="button" class="sg-tog" class:sg-on={warnUnsafeDml} aria-pressed={warnUnsafeDml} aria-label="Toggle warn unsafe DML" onclick={() => { warnUnsafeDml = !warnUnsafeDml; }}><span class="sg-knob"></span></button>
            <span class="sg-toggle-label">Warn unsafe DML</span>
            <button type="button" class="sg-hint-btn" onclick={() => toggleHint("dml")}>?</button>
          </div>
          {#if expandedHints.has("dml")}
            <div class="sg-hint-text">Show EXPLAIN PLAN + estimated rows before running UPDATE/DELETE without a WHERE clause.</div>
          {/if}
          <div class="sg-toggle-row" class:sg-row-locked={env === "prod"}>
            <button type="button" class="sg-tog" class:sg-on={effectiveAirgap} class:sg-locked={env === "prod"} aria-pressed={effectiveAirgap} aria-label="Toggle air-gap mode" disabled={env === "prod"} onclick={() => { airgapMode = !airgapMode; airgapTouched = true; }}><span class="sg-knob"></span></button>
            <span class="sg-toggle-label">🔒 Air-gap {#if env === "prod"}<span class="sg-lock-note">locked</span>{/if}</span>
            <button type="button" class="sg-hint-btn" onclick={() => toggleHint("airgap")}>?</button>
          </div>
          {#if expandedHints.has("airgap")}
            <div class="sg-hint-text">Hard-disable AI, cloud sync, sandbox, and any outbound HTTPS while this connection is active. Forced ON when env=prod — override env first to disable.</div>
          {/if}
          <div class="sg-toggle-row" class:sg-row-locked={env === "prod"}>
            <button type="button" class="sg-tog" class:sg-on={effectivePsdpm} class:sg-locked={env === "prod"} aria-pressed={effectivePsdpm} aria-label="Toggle PSDPM mode" disabled={env === "prod"} onclick={() => { psdpmMode = !psdpmMode; }}><span class="sg-knob"></span></button>
            <span class="sg-toggle-label">🔐 PSDPM {#if env === "prod"}<span class="sg-lock-note">locked</span>{/if}</span>
            <button type="button" class="sg-hint-btn" onclick={() => toggleHint("psdpm")}>?</button>
          </div>
          {#if expandedHints.has("psdpm")}
            <div class="sg-hint-text">Block AI tools, embed batches, schema pre-fetch, and non-user-initiated SQL. Veesker behaves like PL/SQL Developer — nothing runs unless you click. Forced ON for prod; defaults ON for staging.</div>
          {/if}
          <div class="sg-preview">
            <div class="sg-preview-title">Active with these settings</div>
            {#if previewLines.length === 0}
              <div class="sg-preview-empty">No guards active — all defaults</div>
            {:else}
              {#each previewLines as line (line.text)}
                <div class="sg-preview-line" style={line.accent ? `color:${line.accent}` : ""}>· {line.text}</div>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <div class="actions">
    <button type="button" class="ghost" onclick={onTest} disabled={testState.kind === "running"}>
      {testState.kind === "running" ? "Testing…" : "Test"}
    </button>
    <button type="button" class="ghost" onclick={onCancel}>Cancel</button>
    <button type="submit" disabled={saveState.kind === "running" || !canSave}>
      {saveState.kind === "running" ? "Saving…" : submitLabel}
    </button>
  </div>

  {#if testState.kind === "ok"}
    <div class="status ok">
      <strong>Connected.</strong>
      <span>{testState.serverVersion}</span>
      <span class="meta">{testState.elapsedMs} ms</span>
    </div>
  {:else if testState.kind === "err"}
    <div class="status err">
      <strong>Test failed.</strong>
      <span>{testState.message}</span>
    </div>
  {/if}

  {#if saveState.kind === "err"}
    <div class="status err">
      <strong>Save failed.</strong>
      <span>{saveState.message}</span>
    </div>
  {/if}
  {#if !canSave && env === ""}
    <div class="status err">
      <strong>Environment required.</strong>
      <span>Open Safety guards and select an environment (dev / local / staging / prod) before saving.</span>
    </div>
  {:else if !canSave && isProdUpgrade}
    <div class="status err">
      <strong>Confirm PROD upgrade.</strong>
      <span>Check the confirmation checkbox in Safety guards to upgrade to PROD.</span>
    </div>
  {/if}
  {#if showDisclaimer}
    <SecurityDisclaimerModal
      onAccept={() => { showDisclaimer = false; void doSave(); }}
      onCancel={() => { showDisclaimer = false; }}
    />
  {/if}
</form>

<style>
  form { display: flex; flex-direction: column; gap: 1rem; }
  label {
    display: flex; flex-direction: column; gap: 0.35rem;
    font-family: "Inter", sans-serif; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-secondary);
  }
  input, select {
    font-family: "Inter", sans-serif; font-size: 14px; font-weight: 400;
    text-transform: none; letter-spacing: normal;
    color: var(--text-primary); background: var(--bg-surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px; padding: 0.6rem 0.75rem;
  }
  input:focus, select:focus { outline: none; border-color: #b33e1f; }
  .row { display: grid; grid-template-columns: 1fr 2fr; gap: 1rem; }
  .auth-toggle, .auth-fixed {
    display: flex; flex-direction: row; gap: 1rem;
    padding: 0.75rem 1rem; background: var(--bg-surface-raised);
    border: 1px solid var(--border); border-radius: 6px;
    font-family: "Inter", sans-serif; font-size: 13px; color: var(--text-primary);
    text-transform: none; letter-spacing: normal; font-weight: 400;
  }
  .radio { flex-direction: row; align-items: center; gap: 0.4rem;
    text-transform: none; letter-spacing: normal; font-weight: 400; font-size: 13px;
    color: var(--text-primary);
  }
  .radio input { margin: 0; }
  .wallet-pick { display: flex; flex-direction: column; gap: 0.5rem;
    padding: 0.75rem 1rem; background: var(--bg-surface-raised);
    border: 1px dashed var(--border-strong); border-radius: 6px;
  }
  .wallet-label {
    font-family: "Inter", sans-serif; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-secondary);
  }
  .wallet-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .path-mono {
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 12px; color: var(--text-primary);
    word-break: break-all;
  }
  .muted { color: var(--text-secondary); font-size: 13px; }
  .err { color: #7a2a14; font-size: 13px; }
  .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  button {
    flex: 1; font-family: "Space Grotesk", sans-serif; font-size: 14px;
    font-weight: 500; letter-spacing: 0.04em; color: var(--bg-surface);
    background: var(--text-primary); border: none; border-radius: 6px;
    padding: 0.85rem 1rem; cursor: pointer;
  }
  button.ghost { color: var(--text-primary); background: transparent;
    border: 1px solid var(--border-strong);
  }
  button:disabled { opacity: 0.5; cursor: progress; }
  button:hover:not(:disabled) {
    background: #b33e1f; color: #f6f1e8; border-color: #b33e1f;
  }
  .banner { padding: 0.75rem 1rem; border-radius: 6px;
    font-family: "Inter", sans-serif; font-size: 13px;
  }
  .banner.warn { background: rgba(179, 62, 31, 0.08);
    color: #7a2a14; border: 1px solid rgba(179, 62, 31, 0.3);
  }
  .status { font-family: "Inter", sans-serif; font-size: 13px;
    line-height: 1.5; padding: 0.85rem 1rem; border-radius: 6px;
    display: flex; flex-direction: column; gap: 0.25rem;
  }
  .status.ok { background: rgba(46, 125, 50, 0.08);
    color: #1b5e20; border: 1px solid rgba(46, 125, 50, 0.25);
  }
  .status.err { background: rgba(179, 62, 31, 0.08);
    color: #7a2a14; border: 1px solid rgba(179, 62, 31, 0.3);
  }
  .meta { font-size: 11px; opacity: 0.6; }

  /* ── Safety panel (F-20 redesign) ────────────────────────── */
  .safety-toggle {
    flex: none; display: flex; align-items: center; gap: 0.5rem;
    background: transparent; border: 1px solid var(--border);
    color: var(--text-secondary); padding: 0.5rem 0.85rem;
    font-family: "Inter", sans-serif; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    border-radius: 6px; cursor: pointer; text-align: left;
  }
  .safety-toggle:hover { background: var(--row-hover); color: var(--text-primary); border-color: var(--border-strong); }
  .safety-toggle-prod { border-color: rgba(192,32,16,0.6) !important; background: rgba(192,32,16,0.08) !important; color: #e84c30 !important; }
  .safety-toggle-local { border-color: rgba(46,160,67,0.45) !important; background: rgba(46,160,67,0.06) !important; }
  .safety-toggle-staging { border-color: rgba(217,153,42,0.45) !important; background: rgba(217,153,42,0.06) !important; }
  .safety-toggle-dev { border-color: rgba(74,158,218,0.35) !important; }
  .safety-summary { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-left: auto; }
  .safety-hint { margin-left: auto; font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: normal; color: var(--text-muted); }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; background: var(--bg-surface-raised); color: var(--text-primary); border: 1px solid var(--border); }
  .badge-prod { background: rgba(192,32,16,0.22); color: #e84c30; border-color: rgba(192,32,16,0.55); font-weight: 700; }
  .badge-staging { background: rgba(217,153,42,0.18); color: #d99c2a; border-color: rgba(217,153,42,0.4); }
  .badge-dev { background: rgba(74,158,218,0.18); color: #4a9eda; border-color: rgba(74,158,218,0.4); }
  .badge-local { background: rgba(46,160,67,0.18); color: #3fb950; border-color: rgba(46,160,67,0.4); }
  .env-required-mark { color: #e84c30; font-weight: 700; }
  .env-untagged-warning { font-family: "Inter", sans-serif; font-size: 11px; font-weight: 600; color: #e84c30; background: rgba(192,32,16,0.1); border: 1px solid rgba(192,32,16,0.35); border-radius: 4px; padding: 4px 8px; }
  .env-select-prod { border-color: rgba(192,32,16,0.6) !important; color: #e84c30 !important; font-weight: 600; }
  .env-select-local { border-color: rgba(46,160,67,0.5) !important; color: #3fb950 !important; }
  .env-select-staging { border-color: rgba(217,153,42,0.5) !important; color: #d99c2a !important; }
  .env-select-dev { border-color: rgba(74,158,218,0.5) !important; color: #4a9eda !important; }
  .badge-ro { background: rgba(106,110,119,0.2); color: var(--text-secondary); }
  .badge-warn { background: rgba(217,153,42,0.18); color: #d99c2a; border-color: rgba(217,153,42,0.4); }
  .badge-airgap { background: rgba(20,24,32,0.85); color: #f6f1e8; border-color: rgba(20,24,32,1); }
  .badge-psdpm { background: rgba(122,90,248,0.18); color: #a78bfa; border-color: rgba(122,90,248,0.4); }
  .badge-explain { background: var(--bg-surface-alt); color: var(--text-primary); border-color: var(--border); }
  .safety-panel { padding: 0.85rem 1rem; background: var(--bg-surface-raised); border: 1px solid var(--border); border-radius: 6px; }
  .sg-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  .sg-col { display: flex; flex-direction: column; gap: 0.4rem; }
  .sg-group-label { font-family: "Inter", sans-serif; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 0.15rem; }
  .sg-field { display: flex; flex-direction: column; gap: 0.3rem; }
  .sg-field-header { display: flex; align-items: center; gap: 0.4rem; }
  .sg-field-name { font-family: "Inter", sans-serif; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-secondary); }
  .sg-field input, .sg-field select, .sg-col > select { font-size: 13px; padding: 0.45rem 0.65rem; }
  .sg-field small { font-family: "Inter", sans-serif; font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: normal; color: var(--text-muted); }
  .sg-immutable { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; background: rgba(179,62,31,0.15); color: #f5a08a; border: 1px solid rgba(179,62,31,0.4); border-radius: 3px; padding: 1px 5px; }
  .sg-toggle-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; min-height: 28px; }
  .sg-row-locked { opacity: 0.65; }
  .sg-toggle-label { flex: 1; font-family: "Inter", sans-serif; font-size: 12px; font-weight: 500; color: var(--text-primary); text-transform: none; letter-spacing: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .sg-lock-note { font-size: 10px; color: #f5a08a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-left: 4px; }
  .sg-tog { width: 32px; height: 18px; border-radius: 9px; background: var(--bg-surface-raised); border: 1px solid var(--border-strong); position: relative; cursor: pointer; flex-shrink: 0; padding: 0; transition: background 0.15s, border-color 0.15s; }
  .sg-tog:disabled { cursor: default; }
  .sg-tog.sg-on { background: rgba(126,201,106,0.2); border-color: rgba(126,201,106,0.55); }
  .sg-tog.sg-locked { background: rgba(245,160,138,0.18); border-color: rgba(245,160,138,0.5); }
  .sg-knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--text-muted); transition: left 0.15s, background 0.15s; }
  .sg-tog.sg-on .sg-knob { left: 16px; background: #7ec96a; }
  .sg-tog.sg-locked .sg-knob { left: 16px; background: #f5a08a; }
  .sg-hint-btn { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--border); background: transparent; color: var(--text-muted); font-size: 9px; font-weight: 700; cursor: pointer; padding: 0; flex-shrink: 0; font-family: "Inter", sans-serif; text-transform: none; letter-spacing: normal; display: flex; align-items: center; justify-content: center; }
  .sg-hint-btn:hover { background: var(--row-hover); color: var(--text-primary); border-color: var(--border-strong); }
  .sg-hint-text { font-family: "Inter", sans-serif; font-size: 11px; font-weight: 400; color: var(--text-secondary); line-height: 1.45; padding: 0.3rem 0.5rem; background: var(--bg-surface-alt); border-radius: 4px; text-transform: none; letter-spacing: normal; border-left: 2px solid var(--border-strong); margin-bottom: 0.15rem; }
  .sg-preview { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  .sg-preview-title { font-family: "Inter", sans-serif; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 0.4rem; }
  .sg-preview-empty { font-family: "Inter", sans-serif; font-size: 11px; color: var(--text-muted); font-style: italic; }
  .sg-preview-line { font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--text-secondary); line-height: 1.65; }
  .env-mismatch-warning { font-family: "Inter", sans-serif; font-size: 11px; font-weight: 500; color: #d99c2a; background: rgba(217,153,42,0.1); border: 1px solid rgba(217,153,42,0.35); border-radius: 4px; padding: 4px 8px; }
  .env-prod-upgrade-warning { font-family: "Inter", sans-serif; font-size: 11px; font-weight: 500; color: #e84c30; background: rgba(192,32,16,0.08); border: 1px solid rgba(192,32,16,0.35); border-radius: 4px; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
  .env-prod-upgrade-confirm { display: flex; align-items: flex-start; gap: 6px; cursor: pointer; font-weight: 600; font-size: 11px; color: inherit; text-transform: none; letter-spacing: normal; }
  .env-prod-upgrade-confirm input { flex-shrink: 0; margin: 1px 0 0 0; cursor: pointer; }
</style>
