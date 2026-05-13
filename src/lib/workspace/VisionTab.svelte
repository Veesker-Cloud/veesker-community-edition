<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Proprietary — Veesker Cloud Edition
-->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import VisionGraph from "./VisionGraph.svelte";
  import VisionDetailDrawer from "./VisionDetailDrawer.svelte";
  import type { VisionGraphResult, VisionNode } from "$lib/workspace";

  type Props = {
    connectionId: string;
    owner: string;
    objectName: string;
    objectType: string;
    onSignIn: () => void;
  };
  const { connectionId, owner, objectName, objectType, onSignIn }: Props = $props();

  type ViewState = "checking" | "locked" | "loading" | "ready" | "error";
  let viewState: ViewState = $state("checking");
  let errorMsg: string | null = $state(null);
  let graph: VisionGraphResult | null = $state(null);
  let selectedNode: VisionNode | null = $state(null);

  let seedOwner = $state(owner);
  let seedName = $state(objectName);
  let seedType = $state(objectType);
  let initGen = 0;

  $effect(() => {
    void owner; void objectName; void objectType;
    seedOwner = owner; seedName = objectName; seedType = objectType;
    selectedNode = null; graph = null;
    void init();
  });

  async function init() {
    const gen = ++initGen;
    viewState = "checking";

    let authErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      if (gen !== initGen) return;
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject("cloud_timeout"), 20000)
        );
        await Promise.race([
          invoke("cloud_api_get", { path: "/v1/auth/ping", params: {} }),
          timeout,
        ]);
        authErr = null;
        break;
      } catch (e) {
        authErr = e;
        if (String(e).includes("not_authenticated") || String(e) === "cloud_timeout") break;
      }
    }

    if (gen !== initGen) return;
    if (authErr !== null) {
      if (String(authErr).includes("not_authenticated")) {
        viewState = "locked";
      } else if (String(authErr) === "cloud_timeout") {
        errorMsg = "Cloud took too long to respond.";
        viewState = "error";
      } else {
        errorMsg = `Cloud connection failed: ${String(authErr)}`;
        viewState = "error";
      }
      return;
    }
    await loadGraph(gen);
  }

  async function loadGraph(gen = initGen) {
    viewState = "loading"; errorMsg = null;
    try {
      const result = await invoke<VisionGraphResult>("vision_graph", {
        owner: seedOwner, objectName: seedName, objectType: seedType,
      });
      if (gen !== initGen) return;
      graph = result;
      viewState = "ready";
    } catch (e) {
      if (gen !== initGen) return;
      errorMsg = String(e);
      viewState = "error";
    }
  }

  function handleNodeDoubleClick(node: VisionNode) {
    selectedNode = null;
    seedOwner = node.owner;
    seedName = node.name;
    seedType = node.type;
    const gen = ++initGen;
    void loadGraph(gen);
  }
</script>

<div class="vision-tab">
  {#if viewState === "checking" || viewState === "loading"}
    <div class="center-state">
      <span class="spinner"></span>
      {viewState === "checking" ? "Connecting to Cloud… (first load may take up to 20s)" : `Building graph for ${seedName}…`}
    </div>

  {:else if viewState === "locked"}
    <div class="center-state locked">
      <div class="lock-icon">◉</div>
      <p>Veesker Vision is exclusive to the Cloud plan.</p>
      <div class="locked-actions">
        <button class="sign-in-btn" onclick={onSignIn}>Sign in to Cloud</button>
        <button class="retry-btn" onclick={() => void init()}>Retry</button>
      </div>
    </div>

  {:else if viewState === "error"}
    <div class="center-state error">
      <p>{errorMsg}</p>
      <button class="retry-btn" onclick={() => void init()}>Retry</button>
    </div>

  {:else if graph}
    <div class="graph-wrap">
      <VisionGraph
        {graph}
        selectedNodeId={selectedNode?.id ?? null}
        onNodeClick={(n) => { selectedNode = n; }}
        onNodeDoubleClick={handleNodeDoubleClick}
      />
      {#if selectedNode}
        <VisionDetailDrawer
          node={selectedNode}
          {connectionId}
          onClose={() => { selectedNode = null; }}
          onExplore={handleNodeDoubleClick}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
.vision-tab { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; }
.graph-wrap { position: relative; flex: 1; overflow: hidden; }
.center-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px; color: var(--text-muted); font-size: 13px;
}
.lock-icon { font-size: 32px; color: #4a9eff; opacity: 0.5; }
.locked-actions { display: flex; gap: 8px; align-items: center; }
.sign-in-btn {
  background: #1a3a6e; color: #7eb3ff; border: 1px solid #2a5090;
  padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer;
}
.sign-in-btn:hover { background: #2a4a8e; }
.retry-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-muted);
  padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer;
}
.spinner {
  width: 16px; height: 16px; border: 2px solid var(--border);
  border-top-color: #4a9eff; border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
