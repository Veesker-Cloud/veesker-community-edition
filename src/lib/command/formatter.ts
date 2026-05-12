// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { CommandSettings } from "./types";
import type { QueryColumn } from "$lib/sql-query";

const NUMERIC_TYPE_RE = /^(NUMBER|FLOAT|INTEGER|DECIMAL|DOUBLE|BINARY_FLOAT|BINARY_DOUBLE)/i;

const ORACLE_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'] as const;

function formatOracleDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const mon = ORACLE_MONTHS[d.getMonth()];
  const year = String(d.getFullYear()).slice(2);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day}-${mon}-${year} ${hh}:${mm}:${ss}`;
}

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
      return formatOracleDate(value);
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

// Returns the Oracle-style execution message for DDL/DML/TCL/DCL statements.
// Returns null for SELECT (or unrecognized) so the caller falls back to formatStatus.
export function getDdlDmlMessage(
  sql: string,
  rowCount: number,
  elapsedMs: number,
  settings: CommandSettings,
): string | null {
  const t = sql.trim();
  let msg: string | null = null;

  if (/^INSERT\b/i.test(t)) {
    msg = rowCount === 1 ? '1 row inserted.' : `${rowCount} rows inserted.`;
  } else if (/^UPDATE\b/i.test(t)) {
    msg = rowCount === 1 ? '1 row updated.' : `${rowCount} rows updated.`;
  } else if (/^DELETE\b/i.test(t)) {
    msg = rowCount === 1 ? '1 row deleted.' : `${rowCount} rows deleted.`;
  } else if (/^MERGE\b/i.test(t)) {
    msg = rowCount === 1 ? '1 row merged.' : `${rowCount} rows merged.`;
  } else if (/^COMMIT\b/i.test(t)) {
    msg = 'Commit complete.';
  } else if (/^ROLLBACK\b/i.test(t)) {
    msg = 'Rollback complete.';
  } else if (/^SAVEPOINT\b/i.test(t)) {
    msg = 'Savepoint created.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i.test(t)) {
    msg = 'View created.';
  } else if (/^DROP\s+VIEW\b/i.test(t)) {
    msg = 'View dropped.';
  } else if (/^CREATE\s+(GLOBAL\s+TEMPORARY\s+|PRIVATE\s+TEMPORARY\s+)?TABLE\b/i.test(t)) {
    msg = 'Table created.';
  } else if (/^DROP\s+TABLE\b/i.test(t)) {
    msg = 'Table dropped.';
  } else if (/^ALTER\s+TABLE\b/i.test(t)) {
    msg = 'Table altered.';
  } else if (/^TRUNCATE\s+TABLE\b/i.test(t)) {
    msg = 'Table truncated.';
  } else if (/^CREATE\s+(UNIQUE\s+|BITMAP\s+)?INDEX\b/i.test(t)) {
    msg = 'Index created.';
  } else if (/^DROP\s+INDEX\b/i.test(t)) {
    msg = 'Index dropped.';
  } else if (/^ALTER\s+INDEX\b/i.test(t)) {
    msg = 'Index altered.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\b/i.test(t)) {
    msg = 'Package body created.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\b/i.test(t)) {
    msg = 'Package created.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(t)) {
    msg = 'Procedure created.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(t)) {
    msg = 'Function created.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(t)) {
    msg = 'Trigger created.';
  } else if (/^CREATE\s+SEQUENCE\b/i.test(t)) {
    msg = 'Sequence created.';
  } else if (/^DROP\s+SEQUENCE\b/i.test(t)) {
    msg = 'Sequence dropped.';
  } else if (/^ALTER\s+SEQUENCE\b/i.test(t)) {
    msg = 'Sequence altered.';
  } else if (/^CREATE\s+(OR\s+REPLACE\s+)?(PUBLIC\s+)?SYNONYM\b/i.test(t)) {
    msg = 'Synonym created.';
  } else if (/^DROP\s+(PUBLIC\s+)?SYNONYM\b/i.test(t)) {
    msg = 'Synonym dropped.';
  } else if (/^CREATE\s+USER\b/i.test(t)) {
    msg = 'User created.';
  } else if (/^DROP\s+USER\b/i.test(t)) {
    msg = 'User dropped.';
  } else if (/^ALTER\s+USER\b/i.test(t)) {
    msg = 'User altered.';
  } else if (/^CREATE\s+ROLE\b/i.test(t)) {
    msg = 'Role created.';
  } else if (/^DROP\s+ROLE\b/i.test(t)) {
    msg = 'Role dropped.';
  } else if (/^COMMENT\s+ON\b/i.test(t)) {
    msg = 'Comment created.';
  } else if (/^GRANT\b/i.test(t)) {
    msg = 'Grant succeeded.';
  } else if (/^REVOKE\b/i.test(t)) {
    msg = 'Revoke succeeded.';
  } else if (/^DROP\b/i.test(t)) {
    msg = 'Object dropped.';
  } else if (/^ALTER\b/i.test(t)) {
    msg = 'Object altered.';
  } else if (/^CREATE\b/i.test(t)) {
    msg = 'Object created.';
  }

  if (msg === null) return null;
  if (!settings.feedback) return '';
  let out = `${msg}\n`;
  if (settings.timing) out += `\nElapsed: ${formatElapsed(elapsedMs)}\n`;
  return out;
}
