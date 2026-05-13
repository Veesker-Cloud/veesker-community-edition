// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { walkFkBfs, type FkEdge, type FkSingleHopFn } from "./fk-walk";
import type { FkClosureEntry, FkClosureResult } from "./types";

export interface ComputeFkClosureInput {
  owner: string;
  primaryTables: string[];
  maxDepth: number;
  singleHop: FkSingleHopFn;
}

export async function computeFkClosure(
  input: ComputeFkClosureInput,
): Promise<FkClosureResult> {
  const bfs = await walkFkBfs(
    input.owner,
    input.primaryTables,
    input.singleHop,
    input.maxDepth,
  );

  // When multiple FKs point at the same table from different parents
  // (e.g. ORDER_ITEMS.PRODUCT_ID and RETURNS.PRODUCT_ID both → PRODUCTS),
  // pick the lexicographically-smallest fromTable so the wizard preview is
  // stable across runs. v1 surfaces only one parent; if owners need to see
  // multiple, change `viaFk` to an array (Plan 7 candidate).
  const edgeByTo = new Map<string, FkEdge>();
  for (const e of bfs.edges) {
    const existing = edgeByTo.get(e.toTable);
    if (!existing || e.fromTable.localeCompare(existing.fromTable) < 0) {
      edgeByTo.set(e.toTable, e);
    }
  }

  const entries: FkClosureEntry[] = bfs.tablesIncluded
    .map((name) => {
      const depth = bfs.tableDepths[name] ?? 0;
      if (depth === 0) return { name, depth };
      const edge = edgeByTo.get(name);
      if (!edge) return { name, depth };
      return {
        name,
        depth,
        viaFk: {
          fromTable: edge.fromTable,
          fromColumns: edge.fromColumns,
          toColumns: edge.toColumns,
        },
      };
    })
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));

  return { entries, edges: bfs.edges };
}
