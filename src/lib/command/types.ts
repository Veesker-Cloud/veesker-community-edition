// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { QueryColumn } from "$lib/sql-query";

export interface CommandSettings {
  linesize: number;
  pagesize: number;
  feedback: boolean;
  heading: boolean;
  timing: boolean;
  serveroutput: boolean;
  null: string;
  colsep: string;
  numformat: string;
  echo: boolean;
  define: boolean;
  termout: boolean;
}

export const DEFAULT_SETTINGS: Readonly<CommandSettings> = Object.freeze({
  linesize: 80,
  pagesize: 14,
  feedback: true,
  heading: true,
  timing: false,
  serveroutput: true,
  null: "",
  colsep: " ",
  numformat: "",
  echo: false,
  define: true,
  termout: true,
});

export type Parsed =
  | { kind: "directive"; name: string; args: string[]; raw: string }
  | { kind: "sql"; text: string; terminator: ";" | "/" | "newline" }
  | { kind: "plsql"; text: string; terminator: "/" }
  | { kind: "comment"; raw: string }
  | { kind: "blank" }
  | { kind: "incomplete"; partial: string }
  | { kind: "error"; code: string; message: string; raw: string };

export interface CommandHistoryEntry {
  id: number;
  connectionId: string;
  ts: number;
  command: string;
  origin: "user_typed" | "script" | "paste";
  status: "ok" | "error" | "cancelled";
  durationMs: number | null;
}

export interface SharedExecResult {
  rows: unknown[][];
  columns: QueryColumn[];
  rowCount: number;
  elapsedMs: number;
  dbmsOutput: string[];
  warnings: string[];
}
