<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  let {
    bytesUploaded,
    totalBytes,
  }: { bytesUploaded: number; totalBytes: number } = $props();

  function fmtMB(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Clamp so a temporary "bytesUploaded > totalBytes" race (rounding) never
  // pushes the bar past 100% or shows a confusing > 100% number.
  let pct = $derived(
    totalBytes > 0
      ? Math.max(0, Math.min(100, (bytesUploaded / totalBytes) * 100))
      : 0,
  );
</script>

<div class="bar-wrap" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
  <div class="bar-fill" style:width="{pct}%"></div>
  <span class="bar-label">
    {fmtMB(bytesUploaded)} / {fmtMB(totalBytes)} · {pct.toFixed(0)}%
  </span>
</div>

<style>
  .bar-wrap {
    position: relative;
    height: 18px;
    margin: 8px 0;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--bg-page);
    overflow: hidden;
  }
  .bar-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--accent, #3b82f6);
    transition: width 80ms linear;
  }
  .bar-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    color: var(--text-primary);
    mix-blend-mode: difference;
    font-family: monospace;
  }
</style>
