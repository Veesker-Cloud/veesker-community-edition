<script lang="ts">
  import { operationsPanel } from "$lib/stores/operations-panel.svelte";
  import ActivityTab from "./ActivityTab.svelte";
  import SessionTab from "./SessionTab.svelte";

  type Props = { onClose?: () => void; connectionEnv?: string };
  let { onClose, connectionEnv = "" }: Props = $props();
</script>

<aside
  class="operations-panel"
  aria-label="Operations Panel"
  class:open={operationsPanel.isOpen}
>
  <header class="ops-head">
    <div class="tabs" role="tablist">
      <button
        role="tab"
        aria-selected={operationsPanel.activeTab === "activity"}
        class:active={operationsPanel.activeTab === "activity"}
        onclick={() => operationsPanel.setTab("activity")}
      >
        Activity
      </button>
      <button
        role="tab"
        aria-selected={operationsPanel.activeTab === "session"}
        class:active={operationsPanel.activeTab === "session"}
        onclick={() => operationsPanel.setTab("session")}
      >
        Session
      </button>
    </div>
    <button class="close-btn" onclick={onClose} aria-label="Close panel">✕</button>
  </header>

  <div class="tab-body">
    {#if operationsPanel.activeTab === "activity"}
      <ActivityTab />
    {:else}
      <SessionTab {connectionEnv} />
    {/if}
  </div>
</aside>

<style>
  .operations-panel {
    position: relative;
    width: 320px; min-width: 280px;
    height: 100%;
    display: flex; flex-direction: column;
    background: #100e0b;
    border-left: 1px solid rgba(255,255,255,0.07);
    overflow: hidden;
  }
  .ops-head {
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    padding: 0 8px;
  }
  .tabs { display: flex; gap: 0; }
  .tabs button {
    background: transparent; border: none;
    color: rgba(255,255,255,0.45);
    font-family: "Space Grotesk", sans-serif;
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em;
    padding: 8px 14px;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .tabs button:hover { color: rgba(255,255,255,0.7); }
  .tabs button.active {
    color: #f6f1e8;
    border-bottom-color: #E85D3C;
  }
  .close-btn {
    background: transparent; border: none;
    color: rgba(255,255,255,0.4);
    font-size: 14px; cursor: pointer;
    padding: 4px 8px;
  }
  .close-btn:hover { color: rgba(255,255,255,0.8); }
  .tab-body {
    flex: 1; display: flex; flex-direction: column;
    overflow: hidden;
  }
</style>
