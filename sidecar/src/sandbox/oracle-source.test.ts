import { describe, expect, it } from "bun:test";
import { buildExtractSql, buildIntrospectionSql, quoteIdent } from "./oracle-source";

describe("oracle-source", () => {
  describe("quoteIdent", () => {
    it("quotes safe identifiers", () => {
      expect(quoteIdent("ORDERS")).toBe('"ORDERS"');
      expect(quoteIdent("CUSTOMERS")).toBe('"CUSTOMERS"');
    });

    it("rejects identifiers with embedded quotes", () => {
      expect(() => quoteIdent('FOO"BAR')).toThrow(/invalid identifier/i);
    });

    it("rejects empty identifiers", () => {
      expect(() => quoteIdent("")).toThrow(/invalid identifier/i);
    });

    it("rejects identifiers exceeding 128 chars", () => {
      expect(() => quoteIdent("X".repeat(129))).toThrow(/invalid identifier/i);
    });

    it("accepts dollar-sign and underscore", () => {
      expect(quoteIdent("ORDERS$2026")).toBe('"ORDERS$2026"');
      expect(quoteIdent("MY_TABLE")).toBe('"MY_TABLE"');
    });
  });

  describe("schema sql builder", () => {
    it("builds a parameterized introspection SQL", () => {
      const sql = buildIntrospectionSql();
      expect(sql).toContain("ALL_TAB_COLUMNS");
      expect(sql).toContain(":owner");
      expect(sql).toContain(":table_name");
      expect(sql).toContain("ORDER BY column_id");
      expect(sql).not.toContain("'");
    });
  });

  describe("extract sql builder", () => {
    it("builds a basic SELECT * with quoted owner+table", () => {
      const sql = buildExtractSql({
        owner: "OWN",
        table: "ORDERS",
      });
      expect(sql).toBe('SELECT * FROM "OWN"."ORDERS"');
    });

    it("appends a WHERE clause when provided", () => {
      const sql = buildExtractSql({
        owner: "OWN",
        table: "ORDERS",
        whereClause: "created_at > SYSDATE - 30",
      });
      expect(sql).toContain('SELECT * FROM "OWN"."ORDERS"');
      expect(sql).toContain("WHERE created_at > SYSDATE - 30");
    });

    it("appends FETCH FIRST when rowCap given", () => {
      const sql = buildExtractSql({
        owner: "OWN",
        table: "ORDERS",
        rowCap: 1000,
      });
      expect(sql).toContain("FETCH FIRST 1000 ROWS ONLY");
    });

    it("rejects unsafe owner or table names", () => {
      expect(() =>
        buildExtractSql({ owner: "OW;DROP", table: "T" }),
      ).toThrow(/invalid identifier/i);
      expect(() =>
        buildExtractSql({ owner: "OWN", table: "T;DROP" }),
      ).toThrow(/invalid identifier/i);
    });

    it("rejects non-integer rowCap", () => {
      expect(() =>
        buildExtractSql({ owner: "OWN", table: "T", rowCap: 3.14 as unknown as number }),
      ).toThrow(/rowCap/i);
    });

    it("rejects negative rowCap", () => {
      expect(() =>
        buildExtractSql({ owner: "OWN", table: "T", rowCap: -5 }),
      ).toThrow(/rowCap/i);
    });
  });
});
