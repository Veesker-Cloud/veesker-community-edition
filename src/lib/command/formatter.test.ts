// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { formatRows, formatStatus } from "./formatter";
import { DEFAULT_SETTINGS } from "./types";
import type { QueryColumn } from "$lib/sql-query";

const cols = (defs: Array<[string, string]>): QueryColumn[] =>
  defs.map(([name, dataType]) => ({ name, dataType }));

describe("formatRows — empty results", () => {
  test("empty rows + HEADING off + FEEDBACK off returns empty string", () => {
    const out = formatRows(
      [],
      cols([["A", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false, feedback: false },
    );
    expect(out).toBe("");
  });

  test("empty rows with HEADING on emits header + separator", () => {
    const out = formatRows(
      [],
      cols([["A", "VARCHAR2"]]),
      DEFAULT_SETTINGS,
    );
    expect(out).toContain("A");
    expect(out).toContain("-");
  });
});

describe("formatRows — header rendering", () => {
  test("single string column with one row renders header + separator + data", () => {
    const out = formatRows([["X"]], cols([["D", "VARCHAR2"]]), DEFAULT_SETTINGS);
    const lines = out.split("\n");
    expect(lines[0]).toBe("D");
    expect(lines[1]).toBe("-");
    expect(lines[2]).toBe("X");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("HEADING off omits header and separator", () => {
    const out = formatRows(
      [["X"]],
      cols([["D", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    expect(out).toBe("X\n");
  });

  test("header has dashes that match column width", () => {
    const out = formatRows(
      [["short"]],
      cols([["LONGNAME", "VARCHAR2"]]),
      DEFAULT_SETTINGS,
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("LONGNAME");
    expect(lines[1]).toBe("--------");
  });
});

describe("formatRows — column separators", () => {
  test("two columns separated by default COLSEP (single space)", () => {
    const out = formatRows(
      [["1", "2"]],
      cols([["A", "VARCHAR2"], ["B", "VARCHAR2"]]),
      DEFAULT_SETTINGS,
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("A B");
    expect(lines[2]).toBe("1 2");
  });

  test("custom COLSEP appears between columns", () => {
    const out = formatRows(
      [["1", "2"]],
      cols([["A", "VARCHAR2"], ["B", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, colsep: " | " },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("A | B");
    expect(lines[2]).toBe("1 | 2");
  });
});

describe("formatRows — pagination (PAGESIZE)", () => {
  test("PAGESIZE 2 with 4 rows repeats header at least twice", () => {
    const out = formatRows(
      [["a"], ["b"], ["c"], ["d"]],
      cols([["X", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, pagesize: 2 },
    );
    const headerLines = out.split("\n").filter((l) => l === "X");
    expect(headerLines.length).toBeGreaterThanOrEqual(2);
  });

  test("PAGESIZE 0 disables pagination — single header for many rows", () => {
    const rows: string[][] = [];
    for (let i = 0; i < 100; i++) rows.push([`r${i}`]);
    const out = formatRows(
      rows,
      cols([["X", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, pagesize: 0 },
    );
    const headerLines = out.split("\n").filter((l) => l.trim() === "X");
    expect(headerLines.length).toBe(1);
  });

  test("PAGESIZE 14 (default) does not repeat header for 10 rows", () => {
    const rows: string[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`r${i}`]);
    const out = formatRows(rows, cols([["X", "VARCHAR2"]]), DEFAULT_SETTINGS);
    const headerLines = out.split("\n").filter((l) => l.trim() === "X");
    expect(headerLines.length).toBe(1);
  });
});

describe("formatRows — NULL substitution", () => {
  test("null cell renders as the NULL setting string", () => {
    const out = formatRows(
      [[null]],
      cols([["X", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, null: "<null>" },
    );
    expect(out).toContain("<null>");
  });

  test("undefined cell renders as the NULL setting string", () => {
    const out = formatRows(
      [[undefined]],
      cols([["X", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, null: "(nil)" },
    );
    expect(out).toContain("(nil)");
  });

  test("default NULL setting is empty string (padded to min column width 1)", () => {
    const out = formatRows(
      [[null]],
      cols([["X", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    expect(out).toBe(" \n");
  });
});

describe("formatRows — numeric alignment", () => {
  test("NUMBER column values right-aligned with leading spaces", () => {
    const out = formatRows(
      [[1], [22], [333]],
      cols([["N", "NUMBER"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("  1");
    expect(lines[1]).toBe(" 22");
    expect(lines[2]).toBe("333");
  });

  test("VARCHAR2 column values left-aligned with trailing spaces", () => {
    const out = formatRows(
      [["a"], ["bb"], ["ccc"]],
      cols([["S", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("a  ");
    expect(lines[1]).toBe("bb ");
    expect(lines[2]).toBe("ccc");
  });

  test("FLOAT type detected as numeric (right-aligned)", () => {
    const out = formatRows(
      [[1.5], [22.5]],
      cols([["F", "FLOAT"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe(" 1.5");
    expect(lines[1]).toBe("22.5");
  });
});

describe("formatRows — NUMFORMAT", () => {
  test("$999,999.99 formats numeric value with currency + thousands + decimals", () => {
    const out = formatRows(
      [[1234.5]],
      cols([["AMOUNT", "NUMBER"]]),
      { ...DEFAULT_SETTINGS, heading: false, numformat: "$999,999.99" },
    );
    expect(out).toContain("$1,234.50");
  });

  test("NUMFORMAT only applies to numeric columns", () => {
    const out = formatRows(
      [["plain"]],
      cols([["S", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false, numformat: "$999,999.99" },
    );
    expect(out).toBe("plain\n");
  });

  test("unrecognized NUMFORMAT falls back to String(value)", () => {
    const out = formatRows(
      [[42]],
      cols([["N", "NUMBER"]]),
      { ...DEFAULT_SETTINGS, heading: false, numformat: "weird-format" },
    );
    expect(out.trim()).toBe("42");
  });

  test("empty NUMFORMAT uses String(value)", () => {
    const out = formatRows(
      [[42.5]],
      cols([["N", "NUMBER"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    expect(out.trim()).toBe("42.5");
  });
});

describe("formatRows — value stringification", () => {
  test("boolean true/false render as strings", () => {
    const out = formatRows(
      [[true], [false]],
      cols([["B", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    expect(out).toContain("true");
    expect(out).toContain("false");
  });

  test("Date instances render as ISO string", () => {
    const d = new Date("2026-05-07T10:00:00.000Z");
    const out = formatRows(
      [[d]],
      cols([["D", "DATE"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    expect(out).toContain("2026-05-07T10:00:00.000Z");
  });

  test("arrays/objects render as JSON.stringify", () => {
    const out = formatRows(
      [[{ a: 1 }]],
      cols([["O", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false },
    );
    expect(out).toContain('{"a":1}');
  });
});

describe("formatRows — LINESIZE truncation", () => {
  test("cell value longer than LINESIZE gets truncated with '...'", () => {
    const longValue = "x".repeat(200);
    const out = formatRows(
      [[longValue]],
      cols([["X", "VARCHAR2"]]),
      { ...DEFAULT_SETTINGS, heading: false, linesize: 20 },
    );
    const line = out.split("\n")[0];
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line).toContain("...");
  });
});

describe("formatStatus", () => {
  test("FEEDBACK off returns empty string", () => {
    expect(
      formatStatus(1, 100, { ...DEFAULT_SETTINGS, feedback: false }),
    ).toBe("");
  });

  test("0 rows returns 'no rows selected'", () => {
    expect(formatStatus(0, 5, DEFAULT_SETTINGS)).toBe("no rows selected\n");
  });

  test("1 row returns '1 row selected.'", () => {
    expect(formatStatus(1, 5, DEFAULT_SETTINGS)).toBe("1 row selected.\n");
  });

  test("5 rows returns '5 rows selected.'", () => {
    expect(formatStatus(5, 10, DEFAULT_SETTINGS)).toBe("5 rows selected.\n");
  });

  test("TIMING on appends Elapsed line for 50ms", () => {
    const out = formatStatus(1, 50, { ...DEFAULT_SETTINGS, timing: true });
    expect(out).toBe("1 row selected.\n\nElapsed: 00:00:00.05\n");
  });

  test("TIMING on for 1m 23.45s", () => {
    const ms = 60_000 + 23_450;
    const out = formatStatus(1, ms, { ...DEFAULT_SETTINGS, timing: true });
    expect(out).toContain("Elapsed: 00:01:23.45\n");
  });

  test("TIMING on for 1h 2m 3.04s", () => {
    const ms = 3_600_000 + 120_000 + 3_040;
    const out = formatStatus(1, ms, { ...DEFAULT_SETTINGS, timing: true });
    expect(out).toContain("Elapsed: 01:02:03.04\n");
  });

  test("TIMING off omits Elapsed line", () => {
    const out = formatStatus(1, 50, DEFAULT_SETTINGS);
    expect(out).not.toContain("Elapsed");
  });
});
