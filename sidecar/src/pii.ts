// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// PII masking for data sent to Anthropic and for command_history storage.
// Mirrors src-tauri/src/pii.rs — keep both pattern lists in sync.
// Source of truth: identical fixture inputs/outputs in both test suites.
// IMPORTANT: over-masking is acceptable; under-masking is not.

const CPF_RE   = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CNPJ_RE  = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
// Credit card: 13-19 consecutive digits with optional spaces/dashes — length check only, no Luhn
// Pattern ends with \d to prevent the optional separator from consuming trailing whitespace.
const CC_RE    = /\b\d(?:[ -]?\d){12,18}\b/g;
// BR phone: (NN) NNNNN-NNNN or (NN) NNNN-NNNN variants
const PHONE_RE = /\(?\d{2}\)?[\s\-]?\d{4,5}[\s\-]?\d{4}\b/g;
// RG: common SP format e.g. 12.345.678-9 or 1.234.567-X
const RG_RE    = /\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b/g;

export const CPF_MARKER   = "⟨CPF_REDACTED⟩";
export const CNPJ_MARKER  = "⟨CNPJ_REDACTED⟩";
export const EMAIL_MARKER = "⟨EMAIL_REDACTED⟩";
export const CC_MARKER    = "⟨CC_REDACTED⟩";
export const PHONE_MARKER = "⟨PHONE_REDACTED⟩";
export const RG_MARKER    = "⟨RG_REDACTED⟩";

export function maskPii(value: string): string {
  // CNPJ before CPF: CNPJ has a slash that CPF doesn't — no overlap, but CNPJ first avoids edge cases.
  return value
    .replace(CNPJ_RE, CNPJ_MARKER)
    .replace(CPF_RE, CPF_MARKER)
    .replace(EMAIL_RE, EMAIL_MARKER)
    .replace(CC_RE, (m) => {
      const digits = m.replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19) return m;
      return CC_MARKER;
    })
    .replace(PHONE_RE, PHONE_MARKER)
    .replace(RG_RE, RG_MARKER);
}

export function maskRowsPii(rows: unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell) =>
      typeof cell === "string" ? maskPii(cell) : cell
    )
  );
}

// Normalize SQL literals for Anthropic context:
// Replace 'string values' with '?' and standalone numbers with ?
// Keeps table/column names, keywords, operators intact.
export function normalizeSqlLiterals(sql: string): string {
  let result = sql.replace(/'(?:[^']|'')*'/g, "'?'");
  result = result.replace(/\b\d+(?:\.\d+)?\b/g, "?");
  return result;
}
