<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->

<script lang="ts">
  import "../app.css";
  import { theme } from "$lib/stores/theme.svelte";
  import { onMount, setContext } from "svelte";
  import { goto } from "$app/navigation";
  import { navigating } from "$app/state";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import AboutDialog from "$lib/workspace/AboutDialog.svelte";
  import HelpModal from "$lib/workspace/HelpModal.svelte";
  import UpdateNotification from "$lib/workspace/UpdateNotification.svelte";
  import CommercialUseModal from "$lib/workspace/CommercialUseModal.svelte";
  import PluginManagerPanel from "$lib/workspace/PluginManagerPanel.svelte";
  import VisualFlowPanel from "$lib/workspace/VisualFlowPanel.svelte";
  import SandboxRevokeModal from "$lib/workspace/SandboxRevokeModal.svelte";
  import { sandboxes } from "$lib/stores/sandboxes.svelte";
  import { license } from "$lib/stores/license.svelte";
  import type { Snippet } from "svelte";
  import { initAuth } from "$lib/services/auth";
  import { CloudAuditService } from "$lib/services/CloudAuditService";
  import { FEATURES } from "$lib/services/features";
  import Toaster from "$lib/components/Toaster.svelte";

  let { children }: { children: Snippet } = $props();
  let showAbout = $state(false);
  let showHelp = $state(false);
  let showCommercialModal = $state(license.needsFirstLaunchPrompt);
  let showPluginManager = $state(false);
  let revokedSandbox = $state<{ sandboxId: string; reason: "deleted" | "expired" | "not_recipient" } | null>(null);
  let showNavBar = $state(false);
  let navTimer: ReturnType<typeof setTimeout> | null = null;

  export const authCtx = $state({ tier: "ce" as "ce" | "cloud", email: "" });
  setContext("auth", authCtx);

  function decodeJwtEmail(token: string): string {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return typeof payload.email === "string" ? payload.email : "";
    } catch { return ""; }
  }

  onMount(() => {
    void (async () => {
      await initAuth();
      const token = await invoke<string | null>("auth_token_get");
      if (token) {
        authCtx.tier = "cloud";
        authCtx.email = decodeJwtEmail(token);
        void getCurrentWindow().setTitle("Veesker Cloud");
      }
      if (FEATURES.cloudAudit) CloudAuditService.start();
    })();

    const unlistenAbout = listen("open-about", () => { showAbout = true; });
    const unlistenHelp = listen("open-help", () => { showHelp = true; });
    const unlistenPlugins = listen("open-plugins", () => { showPluginManager = true; });
    const unlistenNewConn = listen("menu-new-connection", () => { void goto("/connections/new"); });
    const unlistenTrayOpen = listen<string>("tray-open-connection", (e) => {
      if (e.payload) void goto(`/workspace/${e.payload}`);
    });
    const unlistenTrayDisconnect = listen("tray-disconnect", () => { void goto("/"); });
    const unlistenSandboxRevoked = listen<{ sandbox_id: string; reason: "deleted" | "expired" | "not_recipient" }>("sandbox-revoked", (e) => {
      sandboxes.removeRevoked(e.payload.sandbox_id);
      revokedSandbox = { sandboxId: e.payload.sandbox_id, reason: e.payload.reason };
    });
    return () => {
      unlistenAbout.then((fn) => fn());
      unlistenHelp.then((fn) => fn());
      unlistenPlugins.then((fn) => fn());
      unlistenNewConn.then((fn) => fn());
      unlistenTrayOpen.then((fn) => fn());
      unlistenTrayDisconnect.then((fn) => fn());
      unlistenSandboxRevoked.then((fn) => fn());
    };
  });

  $effect(() => {
    document.documentElement.dataset.theme = theme.current;
  });

  $effect(() => {
    document.documentElement.dataset.tier = authCtx.tier;
  });

  $effect(() => {
    if (navigating.to) {
      navTimer = setTimeout(() => { showNavBar = true; }, 150);
    } else {
      if (navTimer) { clearTimeout(navTimer); navTimer = null; }
      showNavBar = false;
    }
  });
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link
    href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
</svelte:head>

{#if showNavBar}
  <div class="nav-progress" aria-hidden="true"></div>
{/if}

{@render children()}

{#if showAbout}
  <AboutDialog onClose={() => { showAbout = false; }} />
{/if}

{#if showHelp}
  <HelpModal onClose={() => { showHelp = false; }} />
{/if}

<UpdateNotification />

{#if showCommercialModal}
  <CommercialUseModal onClose={() => { showCommercialModal = false; }} />
{/if}

{#if showPluginManager}
  <PluginManagerPanel onClose={() => { showPluginManager = false; }} />
{/if}
{#if revokedSandbox}
  <SandboxRevokeModal
    sandboxId={revokedSandbox.sandboxId}
    reason={revokedSandbox.reason}
    onDismiss={() => { revokedSandbox = null; }}
  />
{/if}
<VisualFlowPanel />
<Toaster />

<style>
  /* Global page chrome — was previously only set inside /+page.svelte and
     /workspace/[id]/+page.svelte via :global(body), so a hard-reload
     (Ctrl+R) directly on /sandboxes (or any other route that didn't
     declare its own body bg) left the page rendering on the WebView's
     default white background. Defining it once at the layout level fixes
     every route in one place. */
  :global(body) {
    margin: 0;
    background: var(--bg-page);
    color: var(--text-primary);
    font-family: "Inter", -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .nav-progress {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%);
    background-size: 50% 100%;
    background-repeat: no-repeat;
    animation: nav-progress-slide 1.1s linear infinite;
    z-index: 99999;
    pointer-events: none;
  }

  @keyframes nav-progress-slide {
    0% { background-position: -50% 0; }
    100% { background-position: 150% 0; }
  }
</style>
