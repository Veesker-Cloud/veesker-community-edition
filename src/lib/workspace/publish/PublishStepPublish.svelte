<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import type { PublishWizard } from "$lib/stores/publish-wizard.svelte";
  import {
    buildSandbox,
    publishSandbox,
    grantSandbox,
    type BuildProgressEvent,
  } from "$lib/sandbox";
  import { toasts } from "$lib/stores/toasts.svelte";
  import PhaseChipBar from "./publish/PhaseChipBar.svelte";
  import PublishProgressLog from "./publish/PublishProgressLog.svelte";
  import PublishSuccessCard from "./publish/PublishSuccessCard.svelte";
  import PublishErrorBanner from "./publish/PublishErrorBanner.svelte";
  import UploadProgressBar from "./publish/UploadProgressBar.svelte";

  let { wizard }: { wizard: PublishWizard } = $props();

  let abortController = $state<AbortController | null>(null);

  // `started` MUST stay non-reactive. A previous version held it as $state,
  // which made the `started = true` assignment trigger the same $effect
  // that wrote it. The cleanup function from the first run then fired
  // immediately and zeroed `alive` before the orchestrator's promise chain
  // started — every appendIfAlive/setPhaseIfAlive turned into a no-op,
  // leaving the UI stuck on phase=idle with "(no events yet)" while the
  // sidecar sometimes ran the build invisibly in the background. With a
  // plain `let`, writes don't track and the effect only re-runs when
  // currentStep changes. (Smoke 2026-05-04 surfaced the regression.)
  let started = false;
  // Set to false on component cleanup so no phase function writes into a
  // detached wizard proxy. The $effect cleanup also aborts the AbortController
  // so cooperative cancel fires when the user navigates away mid-publish.
  // Tauri invoke does not natively support AbortSignal — in-flight sidecar
  // RPCs run to completion, but the orchestrator skips subsequent phases
  // as soon as signal.aborted is true.
  let alive = true;

  // Single mount-effect: subscribe to the upload-progress channel BEFORE
  // firing the orchestrator. Two separate effects raced — fast Builds
  // could start emitting progress events before tauri's listen() finished
  // registering the channel, dropping the early ticks and making the bar
  // jump from 0% to mid-stream. The Rust shell normalizes
  // `sandbox.upload-progress` notifications into `sandbox-upload-progress`
  // Tauri events (PR #23 normalizer).
  $effect(() => {
    if (wizard.state.currentStep !== 6) return;
    if (started) return;
    started = true;
    const signal = freshController();
    let unlistenFn: (() => void) | null = null;
    void (async () => {
      try {
        unlistenFn = await listen<{
          sandboxName: string;
          bytesUploaded: number;
          totalBytes: number;
        }>("sandbox-upload-progress", (e) => {
          if (!alive) return;
          // Sanity guard against future interleaving — today there's only
          // one publish wizard at a time, but the filter is cheap.
          if (e.payload.sandboxName !== wizard.state.spec.sandboxName) return;
          wizard.setUploadProgress({
            bytesUploaded: e.payload.bytesUploaded,
            totalBytes: e.payload.totalBytes,
          });
        });
      } catch (err) {
        // listen() failures shouldn't block the build itself — the upload
        // bar will silently stay at 0% but Build → Encrypt → Upload → Done
        // still complete normally, and any per-phase progress lines still
        // render via appendPhaseEvents. Logging the failure into the
        // wizard's own progress log gives the user something to copy when
        // we get a second smoke report.
        const msg = err instanceof Error ? err.message : String(err);
        appendIfAlive(`[${ts()}] WARN: upload-progress listener failed: ${msg}`);
      }
      try {
        await runOrchestrator(signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          toasts.info("Publish cancelled");
          return;
        }
        // runOrchestrator's two phases each catch their own errors and
        // route through setPhaseIfAlive("error", ...). This top-level
        // catch only fires if those guards themselves throw, which is
        // pathological — surface it loudly rather than swallowing.
        const msg = err instanceof Error ? err.message : String(err);
        setPhaseIfAlive("error", `orchestrator crashed: ${msg}`);
        appendIfAlive(`[${ts()}] FATAL: ${msg}`);
      }
    })();
    return () => {
      alive = false;
      abortController?.abort();
      abortController = null;
      if (unlistenFn) unlistenFn();
    };
  });

  function ts(): string {
    return new Date().toTimeString().slice(0, 8);
  }

  function freshController(): AbortSignal {
    abortController?.abort();
    abortController = new AbortController();
    return abortController.signal;
  }

  // Helpers that no-op when the component has unmounted — the wizard proxy
  // is still alive (held by parent route), but writes after unmount go to
  // a UI nobody sees and may confuse the user when they navigate back.
  function appendIfAlive(line: string): void {
    if (!alive) return;
    wizard.appendProgressLine(line);
  }
  function setPhaseIfAlive(phase: Parameters<PublishWizard["setPublishPhase"]>[0], err?: string): void {
    if (!alive) return;
    wizard.setPublishPhase(phase, err);
  }

  function appendPhaseEvents(events: BuildProgressEvent[]): void {
    for (const e of events) {
      let line = `[${ts()}] ${e.phase}`;
      if ("table" in e && typeof e.table === "string") line += ` · ${e.table}`;
      if ("rowCount" in e && typeof e.rowCount === "number") {
        line += ` (${e.rowCount.toLocaleString()} rows)`;
      }
      if ("tablesAdded" in e && Array.isArray(e.tablesAdded)) {
        line += ` (+${e.tablesAdded.length})`;
      }
      appendIfAlive(line);
      if (e.phase === "encrypting") setPhaseIfAlive("encrypt");
    }
  }

  /** Build phase: extracts from Oracle, encrypts, writes the local `.vsk`.
   *  Returns the outPath on success, or `null` if it failed (the failure was
   *  already recorded into the wizard via setPhaseIfAlive("error", ...)). */
  async function runBuildPhase(signal: AbortSignal): Promise<string | null> {
    const conn = wizard.state.source.connectionId;
    const schema = wizard.state.source.schemaName;
    if (!conn || !schema) {
      setPhaseIfAlive("error", "missing connection");
      return null;
    }

    if (signal.aborted) throw new DOMException("Aborted before build", "AbortError");

    setPhaseIfAlive("build");
    appendIfAlive(`[${ts()}] starting build`);

    try {
      const resp = await buildSandbox({
        connectionId: conn,
        schemaName: schema,
        sandboxName: wizard.state.spec.sandboxName,
        ttlDays: wizard.state.spec.ttlDays,
        piiLevel: wizard.state.spec.piiLevel,
        primaryTables: wizard.state.tables.explicit,
        fkWalkDepth: wizard.state.tables.fkDepth,
        excludedPlsql: wizard.getEffectiveExcludedPlsql(),
      });
      appendPhaseEvents(resp.events);
      const errEvt = resp.events.find((e) => e.phase === "error");
      if (errEvt && "message" in errEvt) {
        setPhaseIfAlive("error", String(errEvt.message));
        return null;
      }
      // Persist the produced .vsk path so a later Upload/Grant failure can
      // retry without re-running the (potentially minutes-long) extract.
      if (alive) wizard.setLastBuildOutPath(resp.result.outPath);
      return resp.result.outPath;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      setPhaseIfAlive("error", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Upload + Grant phase. Reads the encrypted `.vsk` at `outPath`, sends it
   *  to R2 via `sandbox.publish`, then issues per-recipient grants. Designed
   *  to be re-runnable on its own when a previous attempt failed mid-upload
   *  or mid-grant — no Oracle extract or encryption work is repeated. */
  async function runPublishPhase(outPath: string, signal: AbortSignal): Promise<void> {
    const schema = wizard.state.source.schemaName;
    if (!schema) {
      setPhaseIfAlive("error", "missing connection");
      return;
    }

    if (signal.aborted) throw new DOMException("Aborted before upload", "AbortError");

    setPhaseIfAlive("upload");
    appendIfAlive(`[${ts()}] uploading…`);

    let pub;
    try {
      pub = await publishSandbox({
        outPath,
        sandboxName: wizard.state.spec.sandboxName,
        ttlDays: wizard.state.spec.ttlDays,
        memberUserIds: wizard.state.spec.recipients
          .map((r) => r.userId)
          .filter((u): u is string => u !== null),
        specJson: {
          source: { schemaName: schema },
          tables: wizard.effectiveTables(),
          piiLevel: wizard.state.spec.piiLevel,
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      setPhaseIfAlive("error", err instanceof Error ? err.message : String(err));
      return;
    }

    if (alive) wizard.setSandboxId(pub.sandbox_id);
    appendIfAlive(`[${ts()}] uploaded · sandbox_id=${pub.sandbox_id}`);

    if (signal.aborted) throw new DOMException("Aborted before grant", "AbortError");

    setPhaseIfAlive("grant");
    for (const r of wizard.state.spec.recipients) {
      // Always key grantResults by the recipient's email (the canonical identity
      // the chip carries). Mixing email + userId in the same Map silently shadows
      // entries when an email collides with an opaque userId.
      if (!r.userId) {
        if (alive) {
          wizard.recordGrantResult(r.email, { error: "no user_id resolved at recipient lookup time" });
        }
        appendIfAlive(`[${ts()}] skipped grant ${r.email} (not onboarded)`);
        continue;
      }
      try {
        await grantSandbox(pub.sandbox_id, r.userId);
        if (alive) wizard.recordGrantResult(r.email, "ok");
        appendIfAlive(`[${ts()}] granted ${r.email}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (alive) wizard.recordGrantResult(r.email, { error: msg });
        appendIfAlive(`[${ts()}] FAILED grant ${r.email}: ${msg}`);
      }
    }

    setPhaseIfAlive("done");
    appendIfAlive(`[${ts()}] done`);
    // R2 holds the canonical bytes now, the sidecar already unlinked the
    // local copy on success — clear our reference so a stale outPath can't
    // confuse a later retry.
    if (alive) wizard.setLastBuildOutPath(null);
  }

  async function runOrchestrator(signal: AbortSignal) {
    const outPath = await runBuildPhase(signal);
    if (outPath === null) return;
    await runPublishPhase(outPath, signal);
  }

  function retry() {
    wizard.softResetPublish();
    const signal = freshController();
    // Re-fire the orchestrator directly. The mount-time $effect won't fire
    // again (its `started` guard is non-reactive on purpose — see comment
    // at the top), and the upload-progress listener registered at mount
    // is still subscribed, so we just need to drive the build phases
    // again. Keeping `started` as it was is fine: the user navigated to
    // an error state on this Step 5 instance and is asking to redo it.
    void (async () => {
      try {
        await runOrchestrator(signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          toasts.info("Publish cancelled");
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setPhaseIfAlive("error", `orchestrator crashed: ${msg}`);
        appendIfAlive(`[${ts()}] FATAL: ${msg}`);
      }
    })();
  }

  /** Skip the Build phase and re-run only Upload + Grant against the
   *  `.vsk` produced by the last successful Build. Surfaced in the error
   *  banner only when the wizard has a `lastBuildOutPath` to resume from. */
  async function retryFromUpload() {
    const outPath = wizard.state.publish.lastBuildOutPath;
    if (!outPath) {
      // No resumable build — defensive fallback. The button shouldn't have
      // been visible in this state, so treat as a full retry.
      retry();
      return;
    }
    const signal = freshController();
    // Clear publish output but KEEP lastBuildOutPath (we just read it).
    wizard.state.publish.error = null;
    wizard.state.publish.progressLines = [];
    wizard.state.publish.grantResults.clear();
    wizard.state.publish.sandboxId = null;
    wizard.setUploadProgress(null);
    wizard.setPublishPhase("upload");
    appendIfAlive(`[${ts()}] retry: skipping Build, resuming from Upload`);
    try {
      await runPublishPhase(outPath, signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        toasts.info("Publish cancelled");
        return;
      }
      throw err;
    }
  }

  function backToTables() {
    wizard.softResetPublish();
    wizard.state.currentStep = 2;
    started = false;
  }
</script>

<PhaseChipBar {wizard} />

{#if wizard.state.publish.phase === "done"}
  <PublishSuccessCard {wizard} />
{:else if wizard.state.publish.phase === "error"}
  <PublishErrorBanner
    message={wizard.state.publish.error ?? "(no message)"}
    onRetry={retry}
    onRetryFromUpload={wizard.state.publish.lastBuildOutPath ? retryFromUpload : undefined}
    onBack={backToTables}
  />
  <PublishProgressLog {wizard} />
{:else}
  {#if wizard.state.publish.phase === "upload" && wizard.state.publish.uploadProgress}
    <UploadProgressBar
      bytesUploaded={wizard.state.publish.uploadProgress.bytesUploaded}
      totalBytes={wizard.state.publish.uploadProgress.totalBytes}
    />
  {/if}
  <PublishProgressLog {wizard} />
  <p class="warn">⚠ Don't close this window — closing cancels the publish.</p>
{/if}

<style>
  .warn {
    color: var(--text-muted);
    font-size: 12px;
    padding-top: 8px;
  }
</style>
