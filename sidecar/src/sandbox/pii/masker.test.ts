import { describe, expect, it } from "bun:test";
import { applyMask, type MaskInput } from "./masker";

describe("pii masker", () => {
  describe("hash", () => {
    it("returns 8-char hex deterministic for the same value", () => {
      const a = applyMask({ value: "alice@example.com", maskType: "hash" });
      const b = applyMask({ value: "alice@example.com", maskType: "hash" });
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{8}$/);
    });
    it("differs for different inputs", () => {
      const a = applyMask({ value: "alice@x.com", maskType: "hash" });
      const b = applyMask({ value: "bob@x.com", maskType: "hash" });
      expect(a).not.toBe(b);
    });
    it("returns null for null input", () => {
      expect(applyMask({ value: null, maskType: "hash" })).toBeNull();
    });
  });

  describe("redact", () => {
    it("returns a fixed redaction marker", () => {
      expect(applyMask({ value: "secret", maskType: "redact" })).toBe("[REDACTED]");
    });
    it("preserves null", () => {
      expect(applyMask({ value: null, maskType: "redact" })).toBeNull();
    });
  });

  describe("static", () => {
    it("returns the configured static value", () => {
      expect(
        applyMask({ value: "anything", maskType: "static", staticValue: "test@example.com" }),
      ).toBe("test@example.com");
    });
    it("falls back to empty string if staticValue missing", () => {
      expect(applyMask({ value: "x", maskType: "static" })).toBe("");
    });
  });

  describe("partial", () => {
    it("CPF-like: keeps last 2 digits", () => {
      expect(
        applyMask({
          value: "123.456.789-09",
          maskType: "partial",
          partialKeep: { lead: 0, tail: 2 },
        }),
      ).toBe("************09");
    });
    it("email-like: keeps first 2 + tail of domain", () => {
      expect(
        applyMask({
          value: "alice@example.com",
          maskType: "partial",
          partialKeep: { lead: 2, tail: 4 },
        }),
      ).toBe("al***********.com");
    });
    it("returns full mask if value shorter than lead+tail", () => {
      expect(
        applyMask({
          value: "abc",
          maskType: "partial",
          partialKeep: { lead: 5, tail: 5 },
        }),
      ).toBe("***");
    });
  });
});
