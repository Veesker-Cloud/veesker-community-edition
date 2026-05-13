<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  let { onBack }: { onBack: () => void } = $props();
</script>

<div class="banner">
  <span>⚠ <strong>Some FK-pulled tables are excluded</strong> — members will lose referential integrity. Queries that JOIN those tables will fail.</span>
  <button type="button" onclick={onBack}>Go back to Tables</button>
</div>

<style>
  .banner {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.15);
    color: var(--warn-text, #fbbf24);
    border-left: 3px solid #f59e0b;
    border-radius: 3px;
    margin-bottom: 14px;
    font-size: 13px;
  }
  button {
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
</style>
