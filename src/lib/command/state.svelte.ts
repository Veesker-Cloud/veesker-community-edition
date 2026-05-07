// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { CommandSettings, CommandHistoryEntry } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export type TranscriptEntry =
  | { kind: "echo"; text: string }
  | { kind: "directive-result"; text: string }
  | { kind: "sql-result"; text: string; rowCount: number; elapsedMs: number }
  | { kind: "plsql-result"; text: string; elapsedMs: number }
  | { kind: "dbms-output"; text: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "info"; text: string };

const MAX_TRANSCRIPT = 5000;
const MAX_HISTORY = 1000;

export class CommandModeState {
  settings = $state<CommandSettings>({ ...DEFAULT_SETTINGS });
  transcript = $state<TranscriptEntry[]>([]);
  history = $state<CommandHistoryEntry[]>([]);
  busy = $state(false);
  pendingBlock = $state(false);
  partialBuffer = $state("");
  spoolPath = $state<string | null>(null);
  defines = $state<Record<string, string>>({});
  scriptDepth = $state(0);

  promptLineNumber = $derived(computePromptLineNumber(this.partialBuffer));

  appendTranscript(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT);
    }
  }

  clear(): void {
    this.transcript = [];
  }

  resetSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS };
  }

  setSetting<K extends keyof CommandSettings>(key: K, value: CommandSettings[K]): void {
    this.settings[key] = value;
  }

  setHistory(entries: CommandHistoryEntry[]): void {
    this.history = entries.length > MAX_HISTORY ? entries.slice(-MAX_HISTORY) : [...entries];
  }

  appendHistory(entry: CommandHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  setSpoolPath(path: string | null): void {
    this.spoolPath = path;
  }
}

export function computePromptLineNumber(partialBuffer: string): number {
  if (partialBuffer === "") return 1;
  let count = 0;
  for (let i = 0; i < partialBuffer.length; i++) {
    if (partialBuffer.charCodeAt(i) === 10) count++;
  }
  return 2 + count;
}
