// HIGH-001 (audit 2026-04-30): tests for client-side SQL redaction.
// Mirrors veesker-cloud/server/src/lib/redact-sql.test.ts. Keep in sync.
import { describe, it, expect } from "vitest";
import { redactSql } from "./redactSql";

describe("redactSql (client mirror)", () => {
  it("redacts IDENTIFIED BY 'plaintext'", () => {
    const r = redactSql("CREATE USER hr IDENTIFIED BY 'secret123'");
    expect(r.matched).toBe(true);
    expect(r.redacted).toContain("***REDACTED***");
    expect(r.redacted).not.toContain("secret123");
  });

  it("redacts IDENTIFIED BY VALUES (Oracle verifier hash)", () => {
    const r = redactSql(`ALTER USER svc IDENTIFIED BY VALUES 'S:01ABC...XYZ'`);
    expect(r.matched).toBe(true);
    expect(r.redacted).toContain("VALUES '***REDACTED***'");
    expect(r.redacted).not.toContain("01ABC");
  });

  it("redacts unquoted IDENTIFIED BY identifier", () => {
    const r = redactSql("CREATE USER guest IDENTIFIED BY temppass");
    expect(r.matched).toBe(true);
    expect(r.redacted).not.toContain("temppass");
  });

  it("redacts PASSWORD '...'", () => {
    const r = redactSql(`CREATE DATABASE LINK l1 CONNECT TO usr PASSWORD 'plinkpass'`);
    expect(r.matched).toBe(true);
    expect(r.redacted).not.toContain("plinkpass");
  });

  it("returns matched=false for benign SQL", () => {
    const r = redactSql("SELECT * FROM employees WHERE salary > 50000");
    expect(r.matched).toBe(false);
    expect(r.redacted).toBe("SELECT * FROM employees WHERE salary > 50000");
  });
});
