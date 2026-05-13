<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/Veesker-Cloud/veesker
-->

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-shell";

  type Props = { onClose: () => void };
  let { onClose }: Props = $props();

  type ModalState = "idle" | "loading" | "error";
  let modalState: ModalState = $state("idle");
  let errorMessage = $state("");

  async function checkout(plan: "monthly" | "yearly") {
    modalState = "loading";
    errorMessage = "";
    try {
      const token = await invoke<string | null>("auth_token_get");
      const res = await fetch("https://api.veesker.cloud/v1/billing/checkout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) throw new Error("checkout_failed");
      const data = await res.json() as { url: string };
      await open(data.url);
      onClose();
    } catch {
      modalState = "error";
      errorMessage = "Failed to start checkout. Please try again.";
    }
  }

  function retry() {
    modalState = "idle";
    errorMessage = "";
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") onClose(); }} />
<div class="backdrop" role="presentation" onclick={onClose}>
  <div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
    <button class="close-btn" aria-label="Close" onclick={onClose}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </button>

    <div class="logo-wrap">
      <img src="/veesker-cloud-logo.png" class="logo" alt="Veesker Cloud" />
    </div>

    {#if modalState === "idle"}
      <h2>Upgrade to Veesker Cloud</h2>
      <p class="lead">Your Oracle AI assistant — schema-aware, no setup required.</p>

      <div class="plans">
        <button class="btn-plan primary" onclick={() => void checkout("monthly")}>
          Monthly — $29 / month
        </button>
        <button class="btn-plan secondary" onclick={() => void checkout("yearly")}>
          Yearly — $290 / year
          <span class="badge-save">Save 17%</span>
        </button>
      </div>

      <button class="btn ce" onclick={onClose}>
        <img src="/ce-logo.png" class="ce-icon" alt="" aria-hidden="true" />
        Continue with CE
      </button>

    {:else if modalState === "loading"}
      <div class="spinner-wrap" aria-label="Loading">
        <div class="spinner"></div>
      </div>
      <p class="lead">Opening checkout…</p>

    {:else}
      <div class="error-icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <circle cx="14" cy="14" r="13" stroke="#ef4444" stroke-width="1.5"/>
          <path d="M14 8v7" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/>
          <circle cx="14" cy="19.5" r="1.25" fill="#ef4444"/>
        </svg>
      </div>
      <h2>Something went wrong</h2>
      <p class="lead error-text">{errorMessage}</p>
      <div class="actions">
        <button class="btn primary-btn" onclick={retry}>Try again</button>
        <button class="btn ce" onclick={onClose}>
          <img src="/ce-logo.png" class="ce-icon" alt="" aria-hidden="true" />
          Continue with CE
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: linear-gradient(160deg, #1a1a22 0%, #141418 100%);
    border: 1px solid rgba(43, 180, 238, 0.18);
    border-radius: 20px;
    padding: 40px 36px 36px;
    max-width: 420px;
    width: 90%;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04),
      0 24px 64px rgba(0, 0, 0, 0.6),
      0 0 80px rgba(43, 180, 238, 0.06);
  }

  .close-btn {
    position: absolute; top: 16px; right: 16px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .close-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }

  .logo-wrap {
    width: 72px; height: 72px;
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid rgba(43, 180, 238, 0.2);
    box-shadow: 0 0 24px rgba(43, 180, 238, 0.15);
    margin-bottom: 4px;
    flex-shrink: 0;
  }
  .logo {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }

  h2 {
    margin: 0;
    font-family: "Space Grotesk", sans-serif;
    font-size: 21px;
    font-weight: 700;
    color: #fff;
    text-align: center;
    letter-spacing: -0.01em;
  }

  .lead {
    margin: 0;
    color: rgba(255,255,255,0.45);
    font-size: 13.5px;
    text-align: center;
    line-height: 1.6;
  }
  .error-text { color: #f87171; }

  .plans {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .btn-plan {
    width: 100%;
    padding: 13px 16px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    font-family: "Space Grotesk", sans-serif;
    transition: background 0.15s, box-shadow 0.15s;
    letter-spacing: 0.01em;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    position: relative;
  }

  .btn-plan.primary {
    background: #2bb4ee;
    color: #fff;
    border: none;
    box-shadow: 0 4px 16px rgba(43, 180, 238, 0.3);
  }
  .btn-plan.primary:hover {
    background: #40bdee;
    box-shadow: 0 4px 24px rgba(43, 180, 238, 0.45);
  }

  .btn-plan.secondary {
    background: rgba(43, 180, 238, 0.1);
    color: rgba(255,255,255,0.85);
    border: 1px solid rgba(43, 180, 238, 0.25);
    box-shadow: 0 2px 8px rgba(43, 180, 238, 0.1);
  }
  .btn-plan.secondary:hover {
    background: rgba(43, 180, 238, 0.17);
    border-color: rgba(43, 180, 238, 0.4);
  }

  .badge-save {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #22c55e;
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 20px;
    padding: 2px 8px;
  }

  .btn {
    width: 100%;
    padding: 11px 0;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    font-family: "Space Grotesk", sans-serif;
    transition: background 0.15s, opacity 0.15s, box-shadow 0.15s;
    letter-spacing: 0.01em;
  }

  .btn.primary-btn {
    background: #2bb4ee;
    color: #fff;
    border: none;
    box-shadow: 0 4px 16px rgba(43, 180, 238, 0.3);
  }
  .btn.primary-btn:hover {
    background: #40bdee;
    box-shadow: 0 4px 24px rgba(43, 180, 238, 0.45);
  }

  .btn.ce {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(179, 62, 31, 0.12);
    color: #e05a2b;
    border: 1px solid rgba(179, 62, 31, 0.3);
    box-shadow: 0 4px 16px rgba(179, 62, 31, 0.15);
  }
  .btn.ce:hover {
    background: rgba(179, 62, 31, 0.2);
    border-color: rgba(179, 62, 31, 0.5);
    box-shadow: 0 4px 24px rgba(179, 62, 31, 0.28);
  }
  .ce-icon {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .actions { display: flex; flex-direction: column; gap: 8px; width: 100%; }

  .spinner-wrap {
    width: 52px; height: 52px;
    display: flex; align-items: center; justify-content: center;
    margin: 6px 0 2px;
  }
  .spinner {
    width: 32px; height: 32px;
    border: 2.5px solid rgba(43, 180, 238, 0.2);
    border-top-color: #2bb4ee;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-icon { margin-bottom: 2px; }
</style>
