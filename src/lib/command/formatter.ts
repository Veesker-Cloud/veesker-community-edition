// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { CommandSettings } from "./types";
import type { QueryColumn } from "$lib/sql-query";

const NUMERIC_TYPE_RE = /^(NUMBER|FLOAT|INTEGER|DECIMAL|DOUBLE|BINARY_FLOAT|BINARY_DOUBLE)/i;

function isNumericCol(c: QueryColumn): boolean {
  return NUMERIC_TYPE_RE.test(c.dataType);
}

function stringifyNumber(value: number, numformat: string): string {
  if (!numformat) return String(value);
  const decimalIdx = numformat.lastIndexOf(".");
  let minimumFractionDigits = 0;
  let maximumFractionDigits = 0;
  if (decimalIdx >= 0) {
    let count = 0;
    for (let i = decimalIdx + 1; i < numformat.length; i++) {
      const ch = numformat[i];
      if (ch === "9" || ch === "0") count++;
      else break;
    }
    minimumFractionDigits = count;
    maximumFractionDigits = count;
  }
  const hasThousands = numformat.includes(",");
  const hasCurrency = numformat.startsWith("$");
  const hasDigitMarker = /[90]/.test(numformat);
  if (!hasDigitMarker) return String(value);
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits,
      maximumFractionDigits,
      useGrouping: hasThousands,
    });
    const formatted = formatter.format(value);
    return hasCurrency ? `$${formatted}` : formatted;
  } catch {
    return String(value);
  }
}

function stringifyValue(value: unknown, settings: CommandSettings, isNumeric: boolean): string {
  if (value === null || value === undefined) return settings.null;
  if (typeof value === "number") {
    return isNumeric ? stringifyNumber(value, settings.numformat) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return String(value);
    }
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  if (maxLen <= 3) return s.slice(0, maxLen);
  return `${s.slice(0, maxLen - 3)}...`;
}

function computeWidths(
  rows: unknown[][],
  columns: QueryColumn[],
  settings: CommandSettings,
): { widths: number[]; rendered: string[][] } {
  const widths: number[] = columns.map((c) => Math.max(settings.heading ? c.name.length : 1, 1));
  const rendered: string[][] = [];
  for (const row of rows) {
    const renderedRow: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const numeric = isNumericCol(col);
      let s = stringifyValue(row[i], settings, numeric);
      if (s.length > settings.linesize) s = truncate(s, settings.linesize);
      if (s.length > widths[i]) widths[i] = s.length;
      renderedRow.push(s);
    }
    rendered.push(renderedRow);
  }
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] > settings.linesize) widths[i] = settings.linesize;
    if (widths[i] < 1) widths[i] = 1;
  }
  return { widths, rendered };
}

function padCell(value: string, width: number, numeric: boolean): string {
  if (value.length > width) value = truncate(value, width);
  return numeric ? value.padStart(width) : value.padEnd(width);
}

function renderHeader(columns: QueryColumn[], widths: number[], colsep: string): string {
  const titles = columns.map((c, i) => padCell(c.name, widths[i], false));
  const seps = widths.map((w) => "-".repeat(w));
  return `${titles.join(colsep)}\n${seps.join(colsep)}\n`;
}

function renderDataLine(
  cells: string[],
  columns: QueryColumn[],
  widths: number[],
  colsep: string,
): string {
  const padded = cells.map((s, i) => padCell(s, widths[i], isNumericCol(columns[i])));
  return `${padded.join(colsep)}\n`;
}

export function formatRows(
  rows: unknown[][],
  columns: QueryColumn[],
  settings: CommandSettings,
): string {
  if (rows.length === 0 && !settings.heading && !settings.feedback) return "";
  if (columns.length === 0) return "";

  const { widths, rendered } = computeWidths(rows, columns, settings);
  let out = "";

  if (settings.heading) {
    out += renderHeader(columns, widths, settings.colsep);
  }

  let rowsSinceHeader = 0;
  for (let i = 0; i < rendered.length; i++) {
    out += renderDataLine(rendered[i], columns, widths, settings.colsep);
    rowsSinceHeader++;
    const isLast = i === rendered.length - 1;
    if (
      settings.heading &&
      settings.pagesize > 0 &&
      rowsSinceHeader >= settings.pagesize &&
      !isLast
    ) {
      out += `\n${renderHeader(columns, widths, settings.colsep)}`;
      rowsSinceHeader = 0;
    }
  }
  return out;
}

function formatElapsed(elapsedMs: number): string {
  const totalHundredths = Math.round(elapsedMs / 10);
  const hundredths = totalHundredths % 100;
  const totalSeconds = Math.floor(totalHundredths / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
}

export function formatStatus(
  rowCount: number,
  elapsedMs: number,
  settings: CommandSettings,
): string {
  if (!settings.feedback) return "";
  let line: string;
  if (rowCount === 0) line = "no rows selected\n";
  else if (rowCount === 1) line = "1 row selected.\n";
  else line = `${rowCount} rows selected.\n`;
  if (settings.timing) {
    line += `\nElapsed: ${formatElapsed(elapsedMs)}\n`;
  }
  return line;
}
