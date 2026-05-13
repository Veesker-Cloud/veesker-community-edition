import { test, expect } from "bun:test";
import {
  maskPii,
  maskRowsPii,
  normalizeSqlLiterals,
  CPF_MARKER,
  CNPJ_MARKER,
  EMAIL_MARKER,
  CC_MARKER,
  PHONE_MARKER,
  RG_MARKER,
} from "./pii";

// SHARED FIXTURES — input/output pairs must match src-tauri/src/pii.rs behavior.

test("masks CPF", () => {
  expect(maskPii("CPF: 123.456.789-00")).toBe(`CPF: ${CPF_MARKER}`);
});

test("masks CNPJ", () => {
  expect(maskPii("CNPJ: 12.345.678/0001-90")).toBe(`CNPJ: ${CNPJ_MARKER}`);
});

test("masks email", () => {
  expect(maskPii("send to user@example.com ok")).toBe(`send to ${EMAIL_MARKER} ok`);
});

test("masks credit card", () => {
  expect(maskPii("card 4111111111111111 end")).toBe(`card ${CC_MARKER} end`);
});

test("masks BR phone", () => {
  expect(maskPii("(11) 99999-9999")).toBe(PHONE_MARKER);
});

test("masks RG", () => {
  expect(maskPii("RG: 12.345.678-9")).toBe(`RG: ${RG_MARKER}`);
});

test("SQL with CPF in WHERE clause", () => {
  const sql = "SELECT * FROM customers WHERE cpf = '123.456.789-00'";
  const masked = maskPii(sql);
  expect(masked).toContain(CPF_MARKER);
  expect(masked).not.toContain("123.456.789-00");
  expect(masked).toContain("SELECT * FROM customers");
});

test("no false positive on plain SQL", () => {
  const sql = "SELECT id, name, salary FROM employees WHERE dept_id = 50";
  expect(maskPii(sql)).toBe(sql);
});

test("CNPJ not mistaken for CPF", () => {
  const result = maskPii("CNPJ: 12.345.678/0001-90");
  expect(result).toContain(CNPJ_MARKER);
  expect(result).not.toContain(CPF_MARKER);
});

test("masks PII in rows", () => {
  const rows = [["João", "joao@test.com", 42]];
  const masked = maskRowsPii(rows);
  expect(masked[0][1]).toBe(EMAIL_MARKER);
  expect(masked[0][2]).toBe(42);
});

test("normalizes SQL literals", () => {
  const sql = "SELECT * FROM emp WHERE name = 'John' AND salary > 5000";
  const result = normalizeSqlLiterals(sql);
  expect(result).toBe("SELECT * FROM emp WHERE name = '?' AND salary > ?");
});

test("does not mask column names in SQL", () => {
  const sql = "SELECT emp_id, first_name FROM employees";
  const result = normalizeSqlLiterals(sql);
  expect(result).toContain("first_name");
});
