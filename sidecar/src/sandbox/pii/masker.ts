import { createHash } from "node:crypto";
import type { VskMaskType } from "@veesker/engine";

export interface MaskInput {
  value: string | null;
  maskType: VskMaskType;
  /** For maskType="static". Defaults to empty string. */
  staticValue?: string;
  /** For maskType="partial". { lead: keep first N, tail: keep last N }. */
  partialKeep?: { lead: number; tail: number };
}

/**
 * Apply a mask to a single column value. Null input returns null
 * (preserves existing nullability — callers should not invoke this
 * for non-PII columns).
 *
 * - `hash`: SHA-256 truncated to 8 hex chars (deterministic; preserves
 *   join-keys but breaks reverse lookup)
 * - `redact`: replaced with `[REDACTED]` literal
 * - `static`: replaced with caller-supplied constant (e.g. fixed test
 *   email so downstream business logic still parses)
 * - `partial`: keep first N + last N chars, replace middle with `*`
 *   (preserves user-recognizable fingerprint, e.g. CPF `************09`)
 */
export function applyMask(input: MaskInput): string | null {
  if (input.value === null) return null;
  switch (input.maskType) {
    case "hash":
      return createHash("sha256").update(input.value).digest("hex").slice(0, 8);
    case "redact":
      return "[REDACTED]";
    case "static":
      return input.staticValue ?? "";
    case "partial": {
      const keep = input.partialKeep ?? { lead: 0, tail: 0 };
      const len = input.value.length;
      if (keep.lead + keep.tail >= len) {
        return "*".repeat(len);
      }
      const lead = input.value.slice(0, keep.lead);
      const tail = input.value.slice(len - keep.tail);
      const middle = "*".repeat(len - keep.lead - keep.tail);
      return lead + middle + tail;
    }
  }
}
