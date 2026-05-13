<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  let {
    value,
    suggested,
    onChange,
  }: {
    value: string;
    suggested: string;
    onChange: (v: string) => void;
  } = $props();

  const masks = ["NONE", "HASH", "FULL", "PREFIX", "SUFFIX"];
</script>

<select
  value={value}
  onchange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}
  aria-label="Mask choice"
>
  {#each masks as m (m)}
    <option value={m}>{m}{m === suggested ? " ✓" : ""}</option>
  {/each}
</select>

<style>
  select {
    padding: 2px 4px;
    font-size: 11px;
    background: var(--bg-page);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: inherit;
  }
</style>
