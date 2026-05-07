// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { formatConnectionLabel, formatPrompt } from "./prompt";

describe("formatPrompt", () => {
  test("first line, single digit", () => {
    expect(formatPrompt({ lineNumber: 1, isContinuation: false })).toBe("  1  ");
  });

  test("continuation, two-digit line", () => {
    expect(formatPrompt({ lineNumber: 12, isContinuation: true })).toBe(" 12  ");
  });

  test("three-digit line", () => {
    expect(formatPrompt({ lineNumber: 999, isContinuation: true })).toBe("999  ");
  });

  test("clamps zero to line 1", () => {
    expect(formatPrompt({ lineNumber: 0, isContinuation: false })).toBe("  1  ");
  });

  test("clamps negative to line 1", () => {
    expect(formatPrompt({ lineNumber: -5, isContinuation: true })).toBe("  1  ");
  });
});

describe("formatConnectionLabel", () => {
  test("user and service both present", () => {
    expect(formatConnectionLabel("SCOTT", "ORCLPDB1")).toBe("SCOTT@ORCLPDB1>");
  });

  test("null user returns empty string", () => {
    expect(formatConnectionLabel(null, "ORCLPDB1")).toBe("");
  });

  test("undefined user returns empty string", () => {
    expect(formatConnectionLabel(undefined, "ORCLPDB1")).toBe("");
  });

  test("empty user returns empty string", () => {
    expect(formatConnectionLabel("", "ORCLPDB1")).toBe("");
  });

  test("user but null service", () => {
    expect(formatConnectionLabel("SCOTT", null)).toBe("SCOTT>");
  });

  test("user but undefined service", () => {
    expect(formatConnectionLabel("SCOTT", undefined)).toBe("SCOTT>");
  });

  test("user but empty service", () => {
    expect(formatConnectionLabel("SCOTT", "")).toBe("SCOTT>");
  });
});
