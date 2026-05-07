// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { LineEditorEvent } from "./line-editor";

export type DecodedAction =
  | { kind: "events"; events: LineEditorEvent[] }
  | { kind: "exit-on-empty" };

export interface DecodeOpts {
  bufferIsEmpty: boolean;
}

const PRINTABLE_MIN = 0x20;
const PRINTABLE_DEL = 0x7f;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function decodeXtermInput(data: string, opts: DecodeOpts): DecodedAction {
  if (data.length === 0) return { kind: "events", events: [] };

  if (data.startsWith(PASTE_START) && data.includes(PASTE_END)) {
    const inner = data.slice(PASTE_START.length, data.indexOf(PASTE_END));
    const text = normalizeNewlines(inner);
    return { kind: "events", events: [{ kind: "paste", text }] };
  }

  if (data.length === 1) {
    return decodeSingleByte(data, opts);
  }

  if (data.startsWith("\x1b[") || data.startsWith("\x1bO")) {
    return decodeEscape(data);
  }

  if (data.includes("\n") || data.includes("\r")) {
    return {
      kind: "events",
      events: [{ kind: "paste", text: normalizeNewlines(data) }],
    };
  }

  return { kind: "events", events: [{ kind: "char", ch: data }] };
}

function decodeSingleByte(data: string, opts: DecodeOpts): DecodedAction {
  const code = data.charCodeAt(0);

  if (code === 0x0d) return { kind: "events", events: [{ kind: "submit" }] };
  if (code === 0x0a) return { kind: "events", events: [{ kind: "submit" }] };
  if (code === 0x7f || code === 0x08) {
    return { kind: "events", events: [{ kind: "backspace" }] };
  }
  if (code === 0x09) return { kind: "events", events: [] };
  if (code === 0x01) return { kind: "events", events: [{ kind: "home" }] };
  if (code === 0x05) return { kind: "events", events: [{ kind: "end" }] };
  if (code === 0x03) return { kind: "events", events: [{ kind: "interrupt" }] };
  if (code === 0x0c) {
    return { kind: "events", events: [{ kind: "clear-screen" }] };
  }
  if (code === 0x04) {
    if (opts.bufferIsEmpty) return { kind: "exit-on-empty" };
    return { kind: "events", events: [{ kind: "delete" }] };
  }
  if (code < PRINTABLE_MIN) return { kind: "events", events: [] };
  if (code === PRINTABLE_DEL) {
    return { kind: "events", events: [{ kind: "backspace" }] };
  }
  return { kind: "events", events: [{ kind: "char", ch: data }] };
}

function decodeEscape(data: string): DecodedAction {
  switch (data) {
    case "\x1b[A":
    case "\x1bOA":
      return { kind: "events", events: [{ kind: "up" }] };
    case "\x1b[B":
    case "\x1bOB":
      return { kind: "events", events: [{ kind: "down" }] };
    case "\x1b[C":
    case "\x1bOC":
      return { kind: "events", events: [{ kind: "right" }] };
    case "\x1b[D":
    case "\x1bOD":
      return { kind: "events", events: [{ kind: "left" }] };
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
    case "\x1b[7~":
      return { kind: "events", events: [{ kind: "home" }] };
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
    case "\x1b[8~":
      return { kind: "events", events: [{ kind: "end" }] };
    case "\x1b[3~":
      return { kind: "events", events: [{ kind: "delete" }] };
    default:
      return { kind: "events", events: [] };
  }
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}
