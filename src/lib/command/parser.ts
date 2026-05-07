// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { Parsed } from "./types";

const PLSQL_OPENERS = new Set(["BEGIN", "DECLARE"]);

type DirectiveCanonical =
  | "SET"
  | "SHOW"
  | "DEFINE"
  | "UNDEFINE"
  | "COLUMN"
  | "ACCEPT"
  | "PROMPT"
  | "EXIT"
  | "CONNECT"
  | "DISCONNECT"
  | "HOST"
  | "CLEAR"
  | "SPOOL"
  | "START"
  | "EDIT"
  | "WHENEVER";

const DIRECTIVE_ALIASES: Record<string, DirectiveCanonical> = {
  SET: "SET",
  SHOW: "SHOW",
  DEFINE: "DEFINE",
  DEF: "DEFINE",
  UNDEFINE: "UNDEFINE",
  UNDEF: "UNDEFINE",
  COL: "COLUMN",
  COLUMN: "COLUMN",
  ACCEPT: "ACCEPT",
  ACC: "ACCEPT",
  PROMPT: "PROMPT",
  PRO: "PROMPT",
  EXIT: "EXIT",
  QUIT: "EXIT",
  CONNECT: "CONNECT",
  CONN: "CONNECT",
  DISCONNECT: "DISCONNECT",
  DISC: "DISCONNECT",
  HOST: "HOST",
  HO: "HOST",
  CLEAR: "CLEAR",
  CL: "CLEAR",
  SPOOL: "SPOOL",
  SPO: "SPOOL",
  START: "START",
  EDIT: "EDIT",
  ED: "EDIT",
  WHENEVER: "WHENEVER",
};

export function tokenizeArgs(rest: string): string[] {
  const tokens: string[] = [];
  const len = rest.length;
  let i = 0;
  while (i < len) {
    while (i < len && (rest[i] === " " || rest[i] === "\t")) i++;
    if (i >= len) break;
    const ch = rest[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let buf = "";
      while (i < len && rest[i] !== quote) {
        buf += rest[i];
        i++;
      }
      if (i < len) i++;
      tokens.push(buf);
      continue;
    }
    let buf = "";
    while (i < len && rest[i] !== " " && rest[i] !== "\t") {
      buf += rest[i];
      i++;
    }
    tokens.push(buf);
  }
  return tokens;
}

function stripTrailingInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let inQ = false;
  let qCloser = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : "";
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inQ) {
      if (ch === qCloser && next === "'") {
        inQ = false;
        i++;
      }
      continue;
    }
    if ((ch === "q" || ch === "Q") && next === "'") {
      const delim = i + 2 < line.length ? line[i + 2] : "";
      if (delim) {
        inQ = true;
        qCloser = pairCloser(delim);
        i += 2;
        continue;
      }
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "-" && next === "-") {
      return line.slice(0, i);
    }
  }
  return line;
}

function pairCloser(open: string): string {
  if (open === "[") return "]";
  if (open === "<") return ">";
  if (open === "(") return ")";
  if (open === "{") return "}";
  return open;
}

function isCommentStart(trimmed: string): boolean {
  if (trimmed.startsWith("--")) return true;
  const upper = trimmed.toUpperCase();
  if (upper === "REM" || upper === "REMARK") return true;
  if (upper.startsWith("REM ") || upper.startsWith("REM\t")) return true;
  if (upper.startsWith("REMARK ") || upper.startsWith("REMARK\t")) return true;
  return false;
}

function firstWord(trimmed: string): string {
  let i = 0;
  while (
    i < trimmed.length &&
    trimmed[i] !== " " &&
    trimmed[i] !== "\t"
  ) {
    i++;
  }
  return trimmed.slice(0, i);
}

function restAfterFirstWord(line: string, wordLen: number): string {
  let i = wordLen;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

function stripTrailingSemicolon(s: string): string {
  return s.replace(/;\s*$/, "");
}

function stripTrailingWhitespace(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function isOnlySlash(line: string): boolean {
  return /^\s*\/\s*$/.test(line);
}

function parseExitArgs(rest: string, raw: string): Parsed {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return { kind: "directive", name: "EXIT", args: [], raw };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      kind: "error",
      code: "SP2-0226",
      message: `Invalid argument supplied: ${trimmed}`,
      raw,
    };
  }
  return { kind: "directive", name: "EXIT", args: [trimmed], raw };
}

function parseDefineArgs(rest: string, raw: string): Parsed {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return { kind: "directive", name: "DEFINE", args: [], raw };
  }
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx < 0) {
    const tokens = trimmed.split(/\s+/);
    return { kind: "directive", name: "DEFINE", args: tokens, raw };
  }
  const name = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  const args: string[] = [];
  if (name !== "") args.push(name);
  if (value !== "") args.push(value);
  return { kind: "directive", name: "DEFINE", args, raw };
}

function parseStartArgs(rest: string, raw: string, alias: "@" | "@@" | "START"): Parsed {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return {
      kind: "error",
      code: "SP2-0310",
      message: `unable to open file (${alias} requires a filename)`,
      raw,
    };
  }
  const args = tokenizeArgs(trimmed);
  return { kind: "directive", name: "START", args, raw };
}

function parseDirective(line: string, word: string, raw: string): Parsed | null {
  const upper = word.toUpperCase();
  const canonical = DIRECTIVE_ALIASES[upper];
  if (!canonical) return null;

  const rest = restAfterFirstWord(line, word.length);
  const restNoSemi = stripTrailingWhitespace(stripTrailingSemicolon(rest));

  switch (canonical) {
    case "EXIT":
      return parseExitArgs(restNoSemi, raw);

    case "PROMPT": {
      const leadingWs = raw.match(/^[ \t]*/)?.[0]?.length ?? 0;
      const wordEndInRaw = leadingWs + word.length;
      const afterWord = raw.slice(wordEndInRaw);
      if (afterWord === "" || (afterWord[0] !== " " && afterWord[0] !== "\t")) {
        return { kind: "directive", name: "PROMPT", args: [""], raw };
      }
      return { kind: "directive", name: "PROMPT", args: [afterWord.slice(1)], raw };
    }

    case "DEFINE":
      return parseDefineArgs(restNoSemi, raw);

    case "UNDEFINE": {
      const tokens = restNoSemi.trim() === "" ? [] : restNoSemi.trim().split(/\s+/);
      return { kind: "directive", name: "UNDEFINE", args: tokens, raw };
    }

    case "SET": {
      const tokens = restNoSemi.trim() === "" ? [] : restNoSemi.trim().split(/\s+/);
      if (tokens.length > 0) tokens[0] = tokens[0].toUpperCase();
      return { kind: "directive", name: "SET", args: tokens, raw };
    }

    case "SHOW": {
      const tokens = restNoSemi.trim() === "" ? [] : restNoSemi.trim().split(/\s+/);
      if (tokens.length > 0) tokens[0] = tokens[0].toUpperCase();
      return { kind: "directive", name: "SHOW", args: tokens, raw };
    }

    case "COLUMN":
    case "ACCEPT":
    case "SPOOL": {
      const args = tokenizeArgs(restNoSemi);
      return { kind: "directive", name: canonical, args, raw };
    }

    case "CLEAR": {
      const tokens = restNoSemi.trim() === "" ? [] : restNoSemi.trim().split(/\s+/);
      return { kind: "directive", name: "CLEAR", args: tokens, raw };
    }

    case "WHENEVER": {
      const tokens = restNoSemi.trim() === "" ? [] : restNoSemi.trim().split(/\s+/);
      return { kind: "directive", name: "WHENEVER", args: tokens, raw };
    }

    case "CONNECT": {
      const tokens = restNoSemi.trim() === "" ? [] : restNoSemi.trim().split(/\s+/);
      return { kind: "directive", name: "CONNECT", args: tokens, raw };
    }

    case "DISCONNECT":
      return { kind: "directive", name: "DISCONNECT", args: [], raw };

    case "HOST": {
      const body = restNoSemi;
      return { kind: "directive", name: "HOST", args: [body], raw };
    }

    case "EDIT": {
      const body = restNoSemi.trim();
      return { kind: "directive", name: "EDIT", args: [body], raw };
    }

    case "START":
      return parseStartArgs(restNoSemi, raw, "START");
  }
}

export class CommandParser {
  private buffer: string[] = [];
  private mode: "idle" | "sql" | "plsql" = "idle";

  feed(line: string): Parsed {
    const isBlank = line.trim() === "";

    if (this.mode === "plsql") {
      if (isOnlySlash(line)) {
        const text = this.buffer.join("\n");
        this.buffer = [];
        this.mode = "idle";
        return { kind: "plsql", text, terminator: "/" };
      }
      this.buffer.push(line);
      return { kind: "incomplete", partial: this.buffer.join("\n") };
    }

    if (this.mode === "sql") {
      if (isBlank) {
        this.buffer.push(line);
        return { kind: "incomplete", partial: this.buffer.join("\n") };
      }
      return this.continueSql(line);
    }

    if (isBlank) return { kind: "blank" };

    if (isOnlySlash(line)) return { kind: "blank" };

    const trimmed = line.trim();

    if (isCommentStart(trimmed)) {
      return { kind: "comment", raw: line };
    }

    if (trimmed.startsWith("@@")) {
      const rest = trimmed.slice(2);
      return parseStartArgs(rest, line, "@@");
    }
    if (trimmed.startsWith("@")) {
      const rest = trimmed.slice(1);
      return parseStartArgs(rest, line, "@");
    }
    if (trimmed.startsWith("!")) {
      const rest = trimmed.slice(1).trim();
      return { kind: "directive", name: "HOST", args: [rest], raw: line };
    }

    const word = firstWord(trimmed);
    const upperWord = word.toUpperCase();

    if (DIRECTIVE_ALIASES[upperWord]) {
      const directive = parseDirective(trimmed, word, line);
      if (directive) return directive;
    }

    if (PLSQL_OPENERS.has(upperWord)) {
      this.mode = "plsql";
      this.buffer = [line];
      return { kind: "incomplete", partial: this.buffer.join("\n") };
    }

    return this.continueSql(line);
  }

  reset(): void {
    this.buffer = [];
    this.mode = "idle";
  }

  isInBlock(): boolean {
    return this.mode === "plsql";
  }

  private continueSql(line: string): Parsed {
    if (this.mode !== "sql") {
      this.mode = "sql";
      this.buffer = [];
    }
    this.buffer.push(line);

    const stripped = stripTrailingWhitespace(stripTrailingInlineComment(line));
    if (stripped.endsWith(";")) {
      const joined = this.buffer.join("\n");
      const cleanedFull = stripTrailingWhitespace(stripTrailingInlineComment(joined));
      const text = cleanedFull.replace(/;\s*$/, "");
      this.buffer = [];
      this.mode = "idle";
      return { kind: "sql", text, terminator: ";" };
    }

    return { kind: "incomplete", partial: this.buffer.join("\n") };
  }
}
