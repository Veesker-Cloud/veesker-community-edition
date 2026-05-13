<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Proprietary — Veesker Cloud Edition
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as d3 from "d3";
  import type { VisionGraphResult, VisionNode } from "$lib/workspace";

  type Props = {
    graph: VisionGraphResult;
    selectedNodeId: string | null;
    onNodeClick: (node: VisionNode) => void;
    onNodeDoubleClick: (node: VisionNode) => void;
  };
  const { graph, selectedNodeId, onNodeClick, onNodeDoubleClick }: Props = $props();

  const TYPE_COLOR: Record<string, string> = {
    TABLE: "#2980b9", VIEW: "#16a085",
    PACKAGE: "#8e44ad", "PACKAGE BODY": "#8e44ad",
    PROCEDURE: "#d35400", FUNCTION: "#c0963c",
    TRIGGER: "#c0392b", SEQUENCE: "#1e8449",
  };

  function nodeColor(type: string): string {
    return TYPE_COLOR[type?.toUpperCase()] ?? "#7f8c8d";
  }

  function nodeRadius(degree: number): number {
    return Math.max(16, Math.min(40, 10 + degree * 2));
  }

  let svgEl: SVGSVGElement;
  let containerEl: HTMLDivElement;
  let simulation: d3.Simulation<any, any> | null = null;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  let svgSelection: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  let w = 0;
  let h = 0;

  onMount(() => {
    w = containerEl.clientWidth;
    h = containerEl.clientHeight;

    const svg = d3.select(svgEl);
    svgSelection = svg;
    const g = svg.append("g");

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => g.attr("transform", event.transform));
    svg.call(zoom);
    zoomBehavior = zoom;

    svg.append("defs").append("marker")
      .attr("id", "arr")
      .attr("viewBox", "0 0 10 10").attr("refX", 20).attr("refY", 5)
      .attr("markerWidth", 6).attr("markerHeight", 6)
      .attr("orient", "auto-start-reverse")
      .append("path").attr("d", "M0,0 L10,5 L0,10 z").attr("fill", "#2a4080");

    const nodes: any[] = graph.nodes.map(n => ({ ...n }));
    const edges: any[] = graph.edges.map(e => ({ ...e }));

    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
    const links = edges.map(e => ({
      source: nodeIndex.get(e.source) ?? 0,
      target: nodeIndex.get(e.target) ?? 0,
      kind: e.kind,
    }));

    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).distance(100).strength(0.3))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collision", d3.forceCollide().radius((d: any) => nodeRadius(d.degree) + 8));

    const link = g.append("g").selectAll("line")
      .data(links).join("line")
      .attr("stroke", "#1e3a5f")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", (d: any) => d.kind === "dep" ? "5,3" : null)
      .attr("marker-end", "url(#arr)");

    const node = g.append("g").selectAll("g")
      .data(nodes).join("g")
      .attr("cursor", "pointer")
      .call(
        d3.drag<any, any>()
          .on("start", (event, d) => { if (!event.active) simulation!.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on("end", (_event, d) => { if (!_event.active) simulation!.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .on("click", (_event, d) => onNodeClick(d))
      .on("dblclick", (_event, d) => onNodeDoubleClick(d));

    node.filter((d: any) => d.isOrigin)
      .append("circle")
      .attr("r", (d: any) => nodeRadius(d.degree) + 5)
      .attr("fill", "none")
      .attr("stroke", "#4a9eff")
      .attr("stroke-width", 1)
      .attr("opacity", 0.4);

    node.append("circle")
      .attr("r", (d: any) => nodeRadius(d.degree))
      .attr("fill", (d: any) => nodeColor(d.type) + "22")
      .attr("stroke", (d: any) => nodeColor(d.type))
      .attr("stroke-width", (d: any) => d.isOrigin ? 2.5 : 1.5);

    node.filter((d: any) => d.status === "INVALID")
      .append("circle")
      .attr("r", 4).attr("cx", (d: any) => nodeRadius(d.degree) - 4)
      .attr("cy", (d: any) => -nodeRadius(d.degree) + 4)
      .attr("fill", "#e74c3c");

    node.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d: any) => nodeRadius(d.degree) + 13)
      .attr("fill", "#8b949e")
      .attr("font-size", 10)
      .attr("font-family", "monospace")
      .text((d: any) => d.name.length > 14 ? d.name.slice(0, 13) + "…" : d.name);

    node.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", (d: any) => nodeColor(d.type))
      .attr("font-size", 8)
      .attr("font-family", "monospace")
      .attr("font-weight", "bold")
      .text((d: any) => {
        const badges: Record<string, string> = {
          TABLE: "TBL", VIEW: "VIEW", PROCEDURE: "PROC", FUNCTION: "FN",
          PACKAGE: "PKG", "PACKAGE BODY": "PKG", TRIGGER: "TRG", SEQUENCE: "SEQ",
        };
        return badges[d.type?.toUpperCase()] ?? d.type?.slice(0, 3) ?? "?";
      });

    let tick = 0;
    simulation.on("tick", () => {
      tick++;
      link
        .attr("x1", (d: any) => d.source.x).attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x).attr("y2", (d: any) => d.target.y);
      node.attr("transform", (d: any) => `translate(${d.x},${d.y})`);
      if (tick >= 300) simulation!.stop();
    });
  });

  onDestroy(() => { simulation?.stop(); });

  export function zoomIn() {
    if (svgSelection && zoomBehavior) svgSelection.transition().call(zoomBehavior.scaleBy, 1.4);
  }
  export function zoomOut() {
    if (svgSelection && zoomBehavior) svgSelection.transition().call(zoomBehavior.scaleBy, 0.7);
  }
  export function resetZoom() {
    if (svgSelection && zoomBehavior)
      svgSelection.transition().call(zoomBehavior.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(0.9));
  }
</script>

<div class="vision-graph" bind:this={containerEl}>
  <svg bind:this={svgEl}></svg>
  <div class="vision-controls">
    <button onclick={zoomIn} title="Zoom in">＋</button>
    <button onclick={zoomOut} title="Zoom out">－</button>
    <button onclick={resetZoom} title="Reset view">⊙</button>
  </div>
  {#if graph.truncated}
    <div class="vision-truncated-banner">
      Graph truncated at {graph.truncatedAt} nodes — schema too large to display fully.
    </div>
  {/if}
</div>

<style>
.vision-graph { position: relative; width: 100%; height: 100%; background: var(--bg-page); }
svg { width: 100%; height: 100%; }
.vision-controls {
  position: absolute; bottom: 12px; left: 12px;
  display: flex; gap: 6px;
}
.vision-controls button {
  background: var(--bg-surface-alt); border: 1px solid var(--border);
  color: var(--text-muted); font-size: 14px; width: 28px; height: 28px;
  border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.vision-controls button:hover { color: var(--text-primary); }
.vision-truncated-banner {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
  background: #3a2a00; color: #ffa657; font-size: 11px;
  padding: 4px 12px; border-radius: 4px; border: 1px solid #5a4000;
  white-space: nowrap;
}
</style>
