/**
 * PII detection regex catalog. Pure regex — no Luhn, no checksum
 * validation in v1 (those are nice-to-haves; pattern shape alone gives
 * us the recall we want, and the column-name heuristic provides
 * precision).
 *
 * Brazilian-aware: CPF, CNPJ, RG, CEP, BR phone numbers are first-class.
 * Plan 6 Level-3 will add Luhn check + AI-assisted free-text scanning.
 */

export type PiiCategory =
  | "email"
  | "cpf-br"
  | "cnpj-br"
  | "rg-br"
  | "phone-br"
  | "cep-br"
  | "credit-card"
  | "ipv4"
  | "ipv6";

export interface PiiPattern {
  category: PiiCategory;
  /** Human label for UI display. */
  label: string;
  regex: RegExp;
}

export const PII_PATTERNS: PiiPattern[] = [
  {
    category: "email",
    label: "Email address",
    regex: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  },
  {
    category: "cpf-br",
    label: "CPF (Brazil)",
    regex: /^(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})$/,
  },
  {
    category: "cnpj-br",
    label: "CNPJ (Brazil)",
    regex: /^(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})$/,
  },
  {
    category: "rg-br",
    label: "RG (Brazil — São Paulo style)",
    regex: /^(?:\d{2}\.\d{3}\.\d{3}-[\dX]|\d{8,9}[\dX]?)$/,
  },
  {
    category: "phone-br",
    label: "Brazilian phone (with or without DDD/+55)",
    regex: /^(?:\+55\s*)?\(?\d{2}\)?[\s-]?\d{4,5}-?\d{4}$/,
  },
  {
    category: "cep-br",
    label: "CEP (Brazil)",
    regex: /^\d{5}-?\d{3}$/,
  },
  {
    category: "credit-card",
    label: "Credit card number",
    regex: /^(?:\d{4}[\s-]?){3,4}\d{1,4}$|^\d{13,19}$/,
  },
  {
    category: "ipv4",
    label: "IPv4 address",
    regex:
      /^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/,
  },
  {
    category: "ipv6",
    label: "IPv6 address",
    regex: /^[0-9a-fA-F:]{2,}$/,
  },
];

const CATEGORY_INDEX: Map<PiiCategory, RegExp> = new Map(
  PII_PATTERNS.map((p) => [p.category, p.regex]),
);

/** Test a single value against a known category regex. Returns false for
 *  unknown category. Trims whitespace before matching. */
export function matchPattern(category: PiiCategory, value: string): boolean {
  const re = CATEGORY_INDEX.get(category);
  if (!re) return false;
  return re.test(value.trim());
}
