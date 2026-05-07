// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { decodeXtermInput } from "./command-input-decoder";

const NON_EMPTY = { bufferIsEmpty: false };
const EMPTY = { bufferIsEmpty: true };

describe("decodeXtermInput — printable", () => {
  test("ASCII letter emits a single char event", () => {
    expect(decodeXtermInput("a", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "char", ch: "a" }],
    });
  });

  test("digit emits a single char event", () => {
    expect(decodeXtermInput("7", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "char", ch: "7" }],
    });
  });

  test("space emits a single char event", () => {
    expect(decodeXtermInput(" ", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "char", ch: " " }],
    });
  });
});

describe("decodeXtermInput — control bytes", () => {
  test("0x7f maps to backspace", () => {
    expect(decodeXtermInput("\x7f", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "backspace" }],
    });
  });

  test("\\b maps to backspace", () => {
    expect(decodeXtermInput("\b", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "backspace" }],
    });
  });

  test("CR maps to submit", () => {
    expect(decodeXtermInput("\r", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "submit" }],
    });
  });

  test("LF maps to submit", () => {
    expect(decodeXtermInput("\n", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "submit" }],
    });
  });

  test("Tab is ignored in D.1", () => {
    expect(decodeXtermInput("\t", NON_EMPTY)).toEqual({
      kind: "events",
      events: [],
    });
  });

  test("Ctrl+A maps to home", () => {
    expect(decodeXtermInput("\x01", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "home" }],
    });
  });

  test("Ctrl+E maps to end", () => {
    expect(decodeXtermInput("\x05", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "end" }],
    });
  });

  test("Ctrl+C maps to interrupt", () => {
    expect(decodeXtermInput("\x03", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "interrupt" }],
    });
  });

  test("Ctrl+L maps to clear-screen", () => {
    expect(decodeXtermInput("\x0c", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "clear-screen" }],
    });
  });

  test("Ctrl+D on empty buffer requests exit", () => {
    expect(decodeXtermInput("\x04", EMPTY)).toEqual({ kind: "exit-on-empty" });
  });

  test("Ctrl+D on non-empty buffer maps to forward delete", () => {
    expect(decodeXtermInput("\x04", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "delete" }],
    });
  });

  test("other low control bytes are ignored", () => {
    expect(decodeXtermInput("\x02", NON_EMPTY)).toEqual({
      kind: "events",
      events: [],
    });
  });
});

describe("decodeXtermInput — escape sequences", () => {
  test("up arrow", () => {
    expect(decodeXtermInput("\x1b[A", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "up" }],
    });
  });

  test("down arrow", () => {
    expect(decodeXtermInput("\x1b[B", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "down" }],
    });
  });

  test("right arrow", () => {
    expect(decodeXtermInput("\x1b[C", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "right" }],
    });
  });

  test("left arrow", () => {
    expect(decodeXtermInput("\x1b[D", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "left" }],
    });
  });

  test("home key (CSI H)", () => {
    expect(decodeXtermInput("\x1b[H", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "home" }],
    });
  });

  test("end key (CSI F)", () => {
    expect(decodeXtermInput("\x1b[F", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "end" }],
    });
  });

  test("delete key (CSI 3~)", () => {
    expect(decodeXtermInput("\x1b[3~", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "delete" }],
    });
  });

  test("SS3 up (\\x1bOA) treated as up", () => {
    expect(decodeXtermInput("\x1bOA", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "up" }],
    });
  });

  test("unknown escape sequence is ignored", () => {
    expect(decodeXtermInput("\x1b[99~", NON_EMPTY)).toEqual({
      kind: "events",
      events: [],
    });
  });
});

describe("decodeXtermInput — paste", () => {
  test("bracketed paste extracts inner text", () => {
    const wrapped = `\x1b[200~hello world\x1b[201~`;
    expect(decodeXtermInput(wrapped, NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "paste", text: "hello world" }],
    });
  });

  test("bracketed paste normalizes CRLF to LF", () => {
    const wrapped = `\x1b[200~line1\r\nline2\x1b[201~`;
    expect(decodeXtermInput(wrapped, NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "paste", text: "line1\nline2" }],
    });
  });

  test("multi-char chunk with newlines becomes a paste", () => {
    expect(decodeXtermInput("ab\ncd", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "paste", text: "ab\ncd" }],
    });
  });

  test("CRLF chunk is normalized in paste", () => {
    expect(decodeXtermInput("ab\r\ncd", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "paste", text: "ab\ncd" }],
    });
  });

  test("multi-char chunk without newlines emits a single char event (e.g. surrogate pair)", () => {
    const emoji = "🐑";
    expect(decodeXtermInput(emoji, NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "char", ch: emoji }],
    });
  });
});

describe("decodeXtermInput — edge cases", () => {
  test("empty string emits no events", () => {
    expect(decodeXtermInput("", NON_EMPTY)).toEqual({
      kind: "events",
      events: [],
    });
  });

  test("uppercase letter emits char event", () => {
    expect(decodeXtermInput("Z", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "char", ch: "Z" }],
    });
  });

  test("punctuation emits char event", () => {
    expect(decodeXtermInput(";", NON_EMPTY)).toEqual({
      kind: "events",
      events: [{ kind: "char", ch: ";" }],
    });
  });
});
