import { describe, expect, it } from "bun:test";
import {
  PII_PATTERNS,
  matchPattern,
  type PiiCategory,
} from "./patterns";

describe("pii patterns", () => {
  it("exposes a non-empty set of categories", () => {
    expect(PII_PATTERNS.length).toBeGreaterThan(5);
  });

  describe("email", () => {
    const cases: Array<[string, boolean]> = [
      ["alice@example.com", true],
      ["bob.smith+filter@sub.domain.co.uk", true],
      ["not-an-email", false],
      ["@nope.com", false],
      ["spaces in@email.com", false],
    ];
    for (const [v, expected] of cases) {
      it(`${expected ? "matches" : "rejects"} ${v}`, () => {
        expect(matchPattern("email", v)).toBe(expected);
      });
    }
  });

  describe("cpf-br", () => {
    it("matches formatted CPF", () => {
      expect(matchPattern("cpf-br", "123.456.789-09")).toBe(true);
    });
    it("matches unformatted 11-digit CPF", () => {
      expect(matchPattern("cpf-br", "12345678909")).toBe(true);
    });
    it("rejects 10-digit number", () => {
      expect(matchPattern("cpf-br", "1234567890")).toBe(false);
    });
    it("rejects mixed alpha", () => {
      expect(matchPattern("cpf-br", "abc.def.ghi-jk")).toBe(false);
    });
  });

  describe("cnpj-br", () => {
    it("matches formatted CNPJ", () => {
      expect(matchPattern("cnpj-br", "12.345.678/0001-95")).toBe(true);
    });
    it("matches unformatted 14-digit CNPJ", () => {
      expect(matchPattern("cnpj-br", "12345678000195")).toBe(true);
    });
  });

  describe("phone-br", () => {
    it("matches +55 formatted", () => {
      expect(matchPattern("phone-br", "+55 (11) 91234-5678")).toBe(true);
    });
    it("matches DDD-only", () => {
      expect(matchPattern("phone-br", "(11) 1234-5678")).toBe(true);
    });
    it("matches 11-digit unformatted", () => {
      expect(matchPattern("phone-br", "11912345678")).toBe(true);
    });
  });

  describe("cep-br", () => {
    it("matches XXXXX-XXX", () => {
      expect(matchPattern("cep-br", "01310-100")).toBe(true);
    });
    it("matches 8-digit unformatted", () => {
      expect(matchPattern("cep-br", "01310100")).toBe(true);
    });
  });

  describe("credit-card", () => {
    it("matches a 16-digit card", () => {
      expect(matchPattern("credit-card", "4111 1111 1111 1111")).toBe(true);
    });
    it("matches no-space variant", () => {
      expect(matchPattern("credit-card", "4111111111111111")).toBe(true);
    });
    it("rejects 12-digit number", () => {
      expect(matchPattern("credit-card", "411111111111")).toBe(false);
    });
  });

  describe("ipv4", () => {
    it("matches a valid IP", () => {
      expect(matchPattern("ipv4", "192.168.1.1")).toBe(true);
    });
    it("matches edge cases", () => {
      expect(matchPattern("ipv4", "0.0.0.0")).toBe(true);
      expect(matchPattern("ipv4", "255.255.255.255")).toBe(true);
    });
    it("rejects 256+", () => {
      expect(matchPattern("ipv4", "256.1.1.1")).toBe(false);
    });
  });

  it("matchPattern returns false for unknown category", () => {
    expect(matchPattern("nonexistent" as PiiCategory, "anything")).toBe(false);
  });
});
