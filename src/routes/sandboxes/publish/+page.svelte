<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { createPublishWizard, type WizardStep } from "$lib/stores/publish-wizard.svelte";
  import PublishStepSource from "$lib/workspace/publish/PublishStepSource.svelte";
  import PublishStepTables from "$lib/workspace/publish/PublishStepTables.svelte";
  import PublishStepSpec from "$lib/workspace/publish/PublishStepSpec.svelte";
  import PublishStepReview from "$lib/workspace/publish/PublishStepReview.svelte";
  import Step5PlsqlReview from "$lib/workspace/publish/Step5PlsqlReview.svelte";
  import PublishStepPublish from "$lib/workspace/publish/PublishStepPublish.svelte";

  const wizard = createPublishWizard();

  const republishId = $derived(page.url.searchParams.get("republishId"));

  $effect(() => {
    if (republishId) {
      wizard.state.mode = "republish";
      wizard.state.republishingSandboxId = republishId;
    }
  });

  const stepLabels: Record<WizardStep, string> = {
    1: "1 · Source",
    2: "2 · Tables",
    3: "3 · Spec",
    4: "4 · Review",
    5: "5 · PL/SQL",
    6: "6 · Publish",
  };

  function handleBack() {
    if (wizard.state.currentStep === 1) {
      void goto("/sandboxes");
    } else {
      wizard.back();
    }
  }

  // Tauri 2's WebView blocks window.confirm() unless the dialog plugin is
  // enabled, so a confirm-prompted cancel was silently a no-op. Just navigate
  // away — the user clicked Cancel intentionally and the wizard state is
  // ephemeral (next visit creates a fresh wizard via createPublishWizard).
  // The beforeunload handler still warns on full window-close mid-publish.
  function handleCancel() {
    void goto("/sandboxes");
  }

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    // Only block close when there is meaningful state to lose. Done + error
    // are terminal states the user is meant to leave from; idle Step 1 is
    // the safe default.
    if (wizard.state.currentStep === 1 && wizard.state.source.connectionId === null) return;
    if (wizard.state.publish.phase === "done") return;
    if (wizard.state.publish.phase === "error") return;
    e.preventDefault();
    e.returnValue = "";
  }
</script>

<svelte:head>
  <title>Publish sandbox · Step {wizard.state.currentStep} of 6 · Veesker</title>
</svelte:head>

<svelte:window onbeforeunload={handleBeforeUnload} />

<div class="wizard">
  <header class="chip-bar">
    <ol aria-label="Wizard steps">
      {#each [1, 2, 3, 4, 5, 6] as s (s)}
        <li
          class="chip"
          class:active={wizard.state.currentStep === s}
          aria-current={wizard.state.currentStep === s ? "step" : undefined}
        >{stepLabels[s as WizardStep]}</li>
      {/each}
    </ol>
    <button type="button" class="cancel" onclick={handleCancel}>Cancel</button>
  </header>

  <main class="step-body">
    {#if wizard.state.currentStep === 1}
      <PublishStepSource {wizard} />
    {:else if wizard.state.currentStep === 2}
      <PublishStepTables {wizard} />
    {:else if wizard.state.currentStep === 3}
      <PublishStepSpec {wizard} />
    {:else if wizard.state.currentStep === 4}
      <PublishStepReview {wizard} />
    {:else if wizard.state.currentStep === 5}
      <Step5PlsqlReview {wizard} />
    {:else if wizard.state.currentStep === 6}
      <PublishStepPublish {wizard} />
    {/if}
  </main>

  <footer class="footer-nav">
    <button type="button" class="btn-secondary" onclick={handleBack}>← Back</button>
    {#if wizard.state.currentStep < 6}
      <button
        type="button"
        class="btn-primary"
        disabled={!wizard.canAdvance()}
        onclick={() => wizard.next()}
      >Next →</button>
    {/if}
  </footer>
</div>

<style>
  .wizard {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100vh;
    background: var(--bg-page);
    color: var(--text-primary);
  }
  .chip-bar {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .chip-bar ol {
    display: flex;
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chip {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 12px;
    color: var(--text-muted);
    background: transparent;
  }
  .chip.active {
    background: var(--accent, #3b82f6);
    color: white;
    border-color: transparent;
  }
  .cancel {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 12px;
    cursor: pointer;
    font-size: 12px;
    font: inherit;
  }
  .cancel:hover {
    color: var(--text-primary);
    background: var(--bg-surface-alt);
  }
  .step-body {
    overflow: auto;
    padding: 24px;
  }
  .footer-nav {
    display: flex;
    justify-content: space-between;
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .btn-primary, .btn-secondary {
    padding: 8px 16px;
    border-radius: 4px;
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 13px;
  }
  .btn-primary {
    background: var(--accent, #3b82f6);
    color: white;
    border-color: transparent;
  }
  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .btn-secondary {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
</style>
