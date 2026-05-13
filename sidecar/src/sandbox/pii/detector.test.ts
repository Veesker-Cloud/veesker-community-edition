import { describe, expect, it } from "bun:test";
import { suggestFromColumnName, COLUMN_NAME_HINTS } from "./detector";
import { scanSampleValues, detectColumnPii } from "./detector";

describe("pii detector — column-name heuristic", () => {
  it("flags 'email' / 'EMAIL' as email", () => {
    expect(suggestFromColumnName("email")?.category).toBe("email");
    expect(suggestFromColumnName("EMAIL")?.category).toBe("email");
    expect(suggestFromColumnName("user_email")?.category).toBe("email");
    expect(suggestFromColumnName("CONTACT_EMAIL")?.category).toBe("email");
  });

  it("flags CPF column variants", () => {
    expect(suggestFromColumnName("cpf")?.category).toBe("cpf-br");
    expect(suggestFromColumnName("nr_cpf")?.category).toBe("cpf-br");
    expect(suggestFromColumnName("CPF_CLIENTE")?.category).toBe("cpf-br");
  });

  it("flags CNPJ column variants", () => {
    expect(suggestFromColumnName("cnpj")?.category).toBe("cnpj-br");
    expect(suggestFromColumnName("CNPJ_EMPRESA")?.category).toBe("cnpj-br");
  });

  it("flags phone variants (PT-BR + EN)", () => {
    expect(suggestFromColumnName("telefone")?.category).toBe("phone-br");
    expect(suggestFromColumnName("phone")?.category).toBe("phone-br");
    expect(suggestFromColumnName("celular")?.category).toBe("phone-br");
    expect(suggestFromColumnName("phone_number")?.category).toBe("phone-br");
  });

  it("flags address-like columns (no specific category, just generic name signal)", () => {
    expect(suggestFromColumnName("nome")?.category).toBe("name-pii");
    expect(suggestFromColumnName("first_name")?.category).toBe("name-pii");
    expect(suggestFromColumnName("nome_completo")?.category).toBe("name-pii");
  });

  it("returns null for non-PII columns", () => {
    expect(suggestFromColumnName("id")).toBeNull();
    expect(suggestFromColumnName("created_at")).toBeNull();
    expect(suggestFromColumnName("status")).toBeNull();
    expect(suggestFromColumnName("total_amount")).toBeNull();
  });

  it("ignores word-internal substring matches", () => {
    // Should NOT flag 'acmecpf_marketing' — column-name heuristic
    // expects the keyword to be a discrete token (delimited by _ or word
    // boundary), not buried inside another identifier.
    const result = suggestFromColumnName("acmecpf_marketing");
    expect(result).toBeNull();
  });

  it("exposes the keyword catalog for UI hints", () => {
    expect(COLUMN_NAME_HINTS.length).toBeGreaterThan(15);
  });
});

describe("pii detector — sample-value scan", () => {
  it("flags email when 80%+ of samples match the email regex", () => {
    const samples = [
      "alice@example.com",
      "bob@x.com",
      "carol@y.org",
      "dan@z.net",
      "ed@a.co",
    ];
    const result = scanSampleValues(samples);
    expect(result?.category).toBe("email");
    expect(result?.matchRate).toBeGreaterThanOrEqual(0.8);
  });

  it("does not flag if match rate is below 80%", () => {
    const samples = ["alice@x.com", "not-an-email", "also-not", "still-not"];
    expect(scanSampleValues(samples)).toBeNull();
  });

  it("ignores null/empty values when computing rate", () => {
    const samples = ["alice@x.com", null, "", "bob@y.com", "  "];
    const result = scanSampleValues(samples);
    expect(result?.category).toBe("email");
  });

  it("returns null for empty input", () => {
    expect(scanSampleValues([])).toBeNull();
    expect(scanSampleValues([null, null])).toBeNull();
  });

  it("flags CPF when most samples are formatted CPFs", () => {
    const result = scanSampleValues([
      "123.456.789-09",
      "234.567.890-12",
      "345.678.901-23",
    ]);
    expect(result?.category).toBe("cpf-br");
  });
});

describe("pii detector — combined detectColumnPii", () => {
  it("returns 'both' signal when name AND samples agree", () => {
    const result = detectColumnPii("user_email", ["alice@x.com", "bob@y.com", "carol@z.org"]);
    expect(result?.signal).toBe("both");
    expect(result?.category).toBe("email");
    expect(result?.confidence).toBeGreaterThan(0.8);
  });

  it("returns 'column-name' signal when name matches but samples are inconclusive", () => {
    const result = detectColumnPii("user_email", ["test", "not-email", "also-not"]);
    expect(result?.signal).toBe("column-name");
    expect(result?.category).toBe("email");
  });

  it("returns 'sample-value' signal when samples match but name doesn't", () => {
    const result = detectColumnPii("contact", ["alice@x.com", "bob@y.com", "carol@z.org"]);
    expect(result?.signal).toBe("sample-value");
    expect(result?.category).toBe("email");
  });

  it("returns null when neither signal matches", () => {
    expect(detectColumnPii("status", ["active", "inactive", "pending"])).toBeNull();
  });

  it("name-pii survives without sample regex confirmation (no regex for free text names)", () => {
    const result = detectColumnPii("nome", ["Alice", "Bob", "Carol"]);
    expect(result?.signal).toBe("column-name");
    expect(result?.category).toBe("name-pii");
  });
});
