import type { VskMaskType } from "@veesker/engine";
import { type PiiCategory } from "./patterns";
import { matchPattern } from "./patterns";

/** A signal describing how a column was detected. */
export type DetectionSignal = "column-name" | "sample-value" | "both";

/** A category we can flag at column-name level even if it doesn't have
 *  a regex pattern (e.g. names, addresses). */
export type DetectableCategory = PiiCategory | "name-pii" | "address";

export interface ColumnNameHint {
  /** Match KEYWORDS against column names; case-insensitive. */
  keyword: string;
  category: DetectableCategory;
  defaultMask: VskMaskType;
}

/** Curated keyword catalog. Keywords match as discrete tokens
 *  (delimited by _, -, or word boundary). */
export const COLUMN_NAME_HINTS: ColumnNameHint[] = [
  // Email
  { keyword: "email", category: "email", defaultMask: "hash" },
  { keyword: "e_mail", category: "email", defaultMask: "hash" },
  // CPF (Brazilian)
  { keyword: "cpf", category: "cpf-br", defaultMask: "partial" },
  // CNPJ (Brazilian)
  { keyword: "cnpj", category: "cnpj-br", defaultMask: "partial" },
  // RG (Brazilian)
  { keyword: "rg", category: "rg-br", defaultMask: "partial" },
  // Phone — both PT-BR and EN
  { keyword: "telefone", category: "phone-br", defaultMask: "partial" },
  { keyword: "celular", category: "phone-br", defaultMask: "partial" },
  { keyword: "phone", category: "phone-br", defaultMask: "partial" },
  { keyword: "fone", category: "phone-br", defaultMask: "partial" },
  { keyword: "ddd", category: "phone-br", defaultMask: "redact" },
  // CEP (Brazilian zip)
  { keyword: "cep", category: "cep-br", defaultMask: "redact" },
  // Names
  { keyword: "nome", category: "name-pii", defaultMask: "redact" },
  { keyword: "name", category: "name-pii", defaultMask: "redact" },
  { keyword: "first_name", category: "name-pii", defaultMask: "redact" },
  { keyword: "last_name", category: "name-pii", defaultMask: "redact" },
  { keyword: "full_name", category: "name-pii", defaultMask: "redact" },
  { keyword: "nome_completo", category: "name-pii", defaultMask: "redact" },
  { keyword: "sobrenome", category: "name-pii", defaultMask: "redact" },
  // Address
  { keyword: "endereco", category: "address", defaultMask: "redact" },
  { keyword: "address", category: "address", defaultMask: "redact" },
  { keyword: "street", category: "address", defaultMask: "redact" },
  { keyword: "rua", category: "address", defaultMask: "redact" },
  // Credit card
  { keyword: "credit_card", category: "credit-card", defaultMask: "partial" },
  { keyword: "cartao", category: "credit-card", defaultMask: "partial" },
  { keyword: "card_number", category: "credit-card", defaultMask: "partial" },
  // IP
  { keyword: "ip", category: "ipv4", defaultMask: "redact" },
  { keyword: "ip_address", category: "ipv4", defaultMask: "redact" },
];

const HINT_INDEX: Map<string, ColumnNameHint> = new Map(
  COLUMN_NAME_HINTS.map((h) => [h.keyword.toLowerCase(), h]),
);

/**
 * Inspect a column name and return a detection suggestion if any
 * keyword matches as a discrete token. Returns null otherwise.
 *
 * Token matching: lowercase the column name, split on `_`, `-`, and
 * non-alphanumeric. Each token is checked against the keyword catalog.
 * Multi-word keywords (e.g. `first_name`) are matched against the
 * full lowercased column name.
 */
export function suggestFromColumnName(columnName: string): ColumnNameHint | null {
  const lower = columnName.toLowerCase();

  // Multi-word keyword check (full string contains keyword as token)
  for (const hint of COLUMN_NAME_HINTS) {
    if (!hint.keyword.includes("_")) continue;
    // Wrap in word boundaries
    const re = new RegExp(`(^|[_\\-])${hint.keyword}([_\\-]|$)`, "i");
    if (re.test(lower)) return hint;
  }

  // Single-token keyword check
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  for (const t of tokens) {
    const hint = HINT_INDEX.get(t);
    if (hint && !hint.keyword.includes("_")) return hint;
  }
  return null;
}

export interface SampleScanResult {
  category: PiiCategory;
  matchRate: number;
}

const SAMPLE_PII_THRESHOLD = 0.8;

/**
 * Scan a sequence of sample values and return the best-matching pattern
 * if at least 80% of non-null values match it. Used as the second
 * detector signal; combined with column-name in {@link detectColumnPii}.
 */
export function scanSampleValues(samples: ReadonlyArray<string | null>): SampleScanResult | null {
  const nonEmpty = samples.filter(
    (s): s is string => s !== null && typeof s === "string" && s.trim().length > 0,
  );
  if (nonEmpty.length === 0) return null;

  // For each pattern category, compute match rate. Best-match wins.
  const categories: PiiCategory[] = [
    "email",
    "cpf-br",
    "cnpj-br",
    "credit-card",
    "ipv4",
    "phone-br",
    "cep-br",
    "rg-br",
    "ipv6",
  ];
  let best: SampleScanResult | null = null;
  for (const cat of categories) {
    let matched = 0;
    for (const v of nonEmpty) {
      if (matchPattern(cat, v)) matched++;
    }
    const rate = matched / nonEmpty.length;
    if (rate >= SAMPLE_PII_THRESHOLD && (best === null || rate > best.matchRate)) {
      best = { category: cat, matchRate: rate };
    }
  }
  return best;
}

export interface ColumnPiiResult {
  category: DetectableCategory;
  signal: DetectionSignal;
  confidence: number;
  defaultMask: VskMaskType;
}

/**
 * Combined column-name + sample-value detection. Returns the highest-
 * confidence signal, or null if neither flagged the column.
 *
 * Confidence:
 * - "both" agreement: 0.95
 * - "column-name" alone (incl. name-pii / address that has no regex): 0.7
 * - "sample-value" alone (regex match without keyword hint): 0.6
 */
export function detectColumnPii(
  columnName: string,
  samples: ReadonlyArray<string | null>,
): ColumnPiiResult | null {
  const nameSig = suggestFromColumnName(columnName);
  const sampleSig = scanSampleValues(samples);

  // Both agreed
  if (nameSig && sampleSig && nameSig.category === sampleSig.category) {
    return {
      category: nameSig.category,
      signal: "both",
      confidence: 0.95,
      defaultMask: nameSig.defaultMask,
    };
  }
  // Column-name only (covers name-pii / address that have no regex pattern)
  if (nameSig) {
    return {
      category: nameSig.category,
      signal: "column-name",
      confidence: 0.7,
      defaultMask: nameSig.defaultMask,
    };
  }
  // Sample-value only
  if (sampleSig) {
    return {
      category: sampleSig.category,
      signal: "sample-value",
      confidence: 0.6,
      defaultMask: defaultMaskForCategory(sampleSig.category),
    };
  }
  return null;
}

function defaultMaskForCategory(c: PiiCategory): VskMaskType {
  switch (c) {
    case "email":
    case "ipv4":
    case "ipv6":
    case "cep-br":
      return "hash";
    case "cpf-br":
    case "cnpj-br":
    case "rg-br":
    case "phone-br":
    case "credit-card":
      return "partial";
  }
}
