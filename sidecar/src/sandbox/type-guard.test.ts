import { describe, test, expect } from "bun:test";
import { guardColumnTypes, formatTypeGuardError } from "./type-guard";

describe("guardColumnTypes — FATAL types", () => {
  test("XMLTYPE is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "COL", dataType: "XMLTYPE" }] });
    expect(report.hasFatal).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.fatal).toBe(true);
    expect(report.issues[0]!.table).toBe("T");
    expect(report.issues[0]!.column).toBe("COL");
    expect(report.issues[0]!.oracleType).toBe("XMLTYPE");
  });

  test("ANYTYPE is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "ANYTYPE" }] });
    expect(report.hasFatal).toBe(true);
    expect(report.issues[0]!.fatal).toBe(true);
  });

  test("ANYDATA is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "ANYDATA" }] });
    expect(report.hasFatal).toBe(true);
  });

  test("ANYDATASET is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "ANYDATASET" }] });
    expect(report.hasFatal).toBe(true);
  });

  test("BFILE is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "BFILE" }] });
    expect(report.hasFatal).toBe(true);
  });

  test("URITYPE is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "URITYPE" }] });
    expect(report.hasFatal).toBe(true);
  });

  test("HTTPURITYPE is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "HTTPURITYPE" }] });
    expect(report.hasFatal).toBe(true);
  });

  test("case insensitive — xmltype is fatal", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "xmltype" }] });
    expect(report.hasFatal).toBe(true);
  });

  test("multiple fatal types across tables", () => {
    const report = guardColumnTypes({
      TABLE_A: [{ name: "COL1", dataType: "XMLTYPE" }],
      TABLE_B: [{ name: "COL2", dataType: "ANYDATA" }],
    });
    expect(report.hasFatal).toBe(true);
    expect(report.issues).toHaveLength(2);
    expect(report.issues.every((i) => i.fatal)).toBe(true);
  });
});

describe("guardColumnTypes — WARN types", () => {
  test("bare NUMBER warns (not fatal)", () => {
    const report = guardColumnTypes({ T: [{ name: "BAL", dataType: "NUMBER" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.fatal).toBe(false);
    expect(report.issues[0]!.message).toContain("DECIMAL(38,18)");
  });

  test("bare FLOAT warns", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "FLOAT" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.fatal).toBe(false);
  });

  test("NUMBER(38,19) warns for scale > 18", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "NUMBER(38,19)" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("scale");
    expect(report.issues[0]!.message).toContain("19");
  });

  test("NUMBER(10,2) is clean", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "NUMBER(10,2)" }] });
    expect(report.issues).toHaveLength(0);
  });

  test("NUMBER(18,18) is clean (scale exactly 18)", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "NUMBER(18,18)" }] });
    expect(report.issues).toHaveLength(0);
  });

  test("TIMESTAMP WITH TIME ZONE warns", () => {
    const report = guardColumnTypes({
      T: [{ name: "X", dataType: "TIMESTAMP WITH TIME ZONE" }],
    });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("timezone");
  });

  test("TIMESTAMP WITH LOCAL TIME ZONE warns", () => {
    const report = guardColumnTypes({
      T: [{ name: "X", dataType: "TIMESTAMP WITH LOCAL TIME ZONE" }],
    });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
  });

  test("CLOB warns", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "CLOB" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("VARCHAR");
  });

  test("NCLOB warns", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "NCLOB" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
  });

  test("LONG warns", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "LONG" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("deprecated");
  });

  test("LONG RAW warns", () => {
    const report = guardColumnTypes({ T: [{ name: "X", dataType: "LONG RAW" }] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("BLOB");
  });

  test("INTERVAL DAY TO SECOND warns", () => {
    const report = guardColumnTypes({
      T: [{ name: "X", dataType: "INTERVAL DAY TO SECOND" }],
    });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("VARCHAR");
  });

  test("INTERVAL YEAR TO MONTH warns", () => {
    const report = guardColumnTypes({
      T: [{ name: "X", dataType: "INTERVAL YEAR TO MONTH" }],
    });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(1);
  });
});

describe("guardColumnTypes — clean types", () => {
  const CLEAN_TYPES = [
    "VARCHAR2(100)",
    "NVARCHAR2(200)",
    "CHAR(10)",
    "DATE",
    "TIMESTAMP",
    "TIMESTAMP(6)",
    "NUMBER(10,2)",
    "NUMBER(20,0)",
    "BLOB",
    "RAW(16)",
    "BINARY_FLOAT",
    "BINARY_DOUBLE",
  ];

  for (const dt of CLEAN_TYPES) {
    test(`${dt} has no issues`, () => {
      const report = guardColumnTypes({ T: [{ name: "C", dataType: dt }] });
      expect(report.issues).toHaveLength(0);
      expect(report.hasFatal).toBe(false);
    });
  }
});

describe("guardColumnTypes — mixed + edge cases", () => {
  test("XMLTYPE (fatal) + bare NUMBER (warn) → hasFatal=true, 2 issues", () => {
    const report = guardColumnTypes({
      T: [
        { name: "C1", dataType: "XMLTYPE" },
        { name: "C2", dataType: "NUMBER" },
        { name: "C3", dataType: "DATE" },
      ],
    });
    expect(report.hasFatal).toBe(true);
    expect(report.issues).toHaveLength(2);
    const fatalIssues = report.issues.filter((i) => i.fatal);
    const warnIssues = report.issues.filter((i) => !i.fatal);
    expect(fatalIssues).toHaveLength(1);
    expect(warnIssues).toHaveLength(1);
  });

  test("empty schemas → no issues", () => {
    const report = guardColumnTypes({});
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(0);
  });

  test("empty column list → no issues", () => {
    const report = guardColumnTypes({ T: [] });
    expect(report.hasFatal).toBe(false);
    expect(report.issues).toHaveLength(0);
  });

  test("table name is preserved in issue", () => {
    const report = guardColumnTypes({
      GL_BALANCES: [{ name: "AMOUNT_DR", dataType: "NUMBER" }],
    });
    expect(report.issues[0]!.table).toBe("GL_BALANCES");
    expect(report.issues[0]!.column).toBe("AMOUNT_DR");
  });

  test("multiple tables — issues span correctly", () => {
    const report = guardColumnTypes({
      ORDERS: [{ name: "ID", dataType: "NUMBER(10,0)" }],
      ORDER_LINES: [{ name: "NOTE", dataType: "CLOB" }],
      PRODUCTS: [{ name: "SPEC", dataType: "XMLTYPE" }],
    });
    expect(report.hasFatal).toBe(true);
    expect(report.issues).toHaveLength(2); // CLOB warn + XMLTYPE fatal
    const tables = report.issues.map((i) => i.table);
    expect(tables).toContain("ORDER_LINES");
    expect(tables).toContain("PRODUCTS");
  });
});

describe("formatTypeGuardError", () => {
  test("renders fatal issues block", () => {
    const report = guardColumnTypes({
      T: [{ name: "X", dataType: "XMLTYPE" }],
    });
    const msg = formatTypeGuardError(report);
    expect(msg).toContain("Sandbox build blocked");
    expect(msg).toContain("1 unsupported column type");
    expect(msg).toContain("FATAL");
    expect(msg).toContain("T.X");
    expect(msg).toContain("XMLTYPE");
  });

  test("renders warnings section when present", () => {
    const report = guardColumnTypes({
      T: [
        { name: "X", dataType: "XMLTYPE" },
        { name: "Y", dataType: "NUMBER" },
      ],
    });
    const msg = formatTypeGuardError(report);
    expect(msg).toContain("WARNINGS");
    expect(msg).toContain("T.Y");
  });

  test("no warnings section when only fatal", () => {
    const report = guardColumnTypes({
      T: [{ name: "X", dataType: "XMLTYPE" }],
    });
    const msg = formatTypeGuardError(report);
    expect(msg).not.toContain("WARNINGS");
  });

  test("plural form for multiple fatals", () => {
    const report = guardColumnTypes({
      T: [
        { name: "A", dataType: "XMLTYPE" },
        { name: "B", dataType: "ANYDATA" },
      ],
    });
    const msg = formatTypeGuardError(report);
    expect(msg).toContain("2 unsupported column types");
  });
});
