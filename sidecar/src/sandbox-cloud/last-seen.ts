// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface LastSeenStore {
  loadLastSeenIds(): Promise<string[]>;
  markSeen(ids: string[]): Promise<void>;
  pruneStale(currentIds: string[]): Promise<void>;
}

interface LastSeenFile {
  ids: string[];
  updated_at: string;
}

export function createLastSeenStore(filePath: string): LastSeenStore {
  async function readFile(): Promise<LastSeenFile> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return { ids: [], updated_at: new Date(0).toISOString() };
    try {
      const parsed = await file.json() as Partial<LastSeenFile>;
      const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter(s => typeof s === "string") : [];
      return { ids, updated_at: parsed?.updated_at ?? new Date(0).toISOString() };
    } catch {
      return { ids: [], updated_at: new Date(0).toISOString() };
    }
  }

  async function writeFile(data: LastSeenFile): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, JSON.stringify(data));
  }

  return {
    async loadLastSeenIds(): Promise<string[]> {
      const data = await readFile();
      return [...data.ids];
    },
    async markSeen(ids: string[]): Promise<void> {
      const data = await readFile();
      const set = new Set(data.ids);
      for (const id of ids) set.add(id);
      await writeFile({ ids: [...set], updated_at: new Date().toISOString() });
    },
    async pruneStale(currentIds: string[]): Promise<void> {
      const data = await readFile();
      if (data.ids.length === 0) return;
      const keep = new Set(currentIds);
      const next = data.ids.filter(id => keep.has(id));
      if (next.length === data.ids.length) return;
      await writeFile({ ids: next, updated_at: new Date().toISOString() });
    },
  };
}
