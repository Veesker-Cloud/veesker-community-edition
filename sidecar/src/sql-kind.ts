// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

/**
 * Conservative SQL classification used by safety guards. Operates on the
 * leading keyword after stripping comments and whitespace. Designed to err on
 * the side of REJECTING rather than passing — read-only mode shouldn't let
 * something "interesting" through.
 */

export type SqlKind =
  | "select"   // pure read: SELECT, WITH, EXPLAIN
  | "dml"      // INSERT, UPDATE, DELETE, MERGE
  | "ddl"      // CREATE, ALTER, DROP, TRUNCATE, RENAME, GRANT, REVOKE, COMMENT
  | "tcl"      // COMMIT, ROLLBACK, SAVEPOINT, SET TRANSACTION
  | "plsql"    // BEGIN ... END / DECLARE block / CREATE PROCEDURE etc (overlaps DDL but treated separately)
  | "session"  // ALTER SESSION, ALTER SYSTEM
  | "unknown";

const COMMENT_LINE_RE = /^\s*--[^\n]*\n/;
const COMMENT_BLOCK_RE = /^\s*\/\*[\s\S]*?\*\//;

export function stripLeadingComments(sql: string): string {
  let s = sql;
  while (true) {
    const before = s.length;
    s = s.replace(COMMENT_LINE_RE, "").replace(COMMENT_BLOCK_RE, "").replace(/^\s+/, "");
    if (s.length === before) break;
  }
  return s;
}

export function classifySql(sql: string): SqlKind {
  const s = stripLeadingComments(sql).toUpperCase();
  if (s.startsWith("SELECT") || s.startsWith("WITH") || s.startsWith("EXPLAIN") || s.startsWith("DESC")) {
    return "select";
  }
  if (s.startsWith("BEGIN") || s.startsWith("DECLARE")) {
    return "plsql";
  }
  // CREATE/ALTER/DROP of code objects = DDL but with PL/SQL inside
  if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/.test(s)) {
    return "plsql";
  }
  if (/^ALTER\s+SESSION\b/.test(s)) return "session";
  if (/^ALTER\s+SYSTEM\b/.test(s)) return "session";
  if (s.startsWith("CREATE") || s.startsWith("ALTER") || s.startsWith("DROP") || s.startsWith("TRUNCATE")) {
    return "ddl";
  }
  if (s.startsWith("RENAME") || s.startsWith("GRANT") || s.startsWith("REVOKE") || s.startsWith("COMMENT")) {
    return "ddl";
  }
  if (s.startsWith("INSERT") || s.startsWith("UPDATE") || s.startsWith("DELETE") || s.startsWith("MERGE") || s.startsWith("UPSERT")) {
    return "dml";
  }
  if (s.startsWith("COMMIT") || s.startsWith("ROLLBACK") || s.startsWith("SAVEPOINT") || /^SET\s+TRANSACTION\b/.test(s)) {
    return "tcl";
  }
  return "unknown";
}

/** Read-only sessions allow these kinds. Session-altering statements are
 * deliberately blocked because they can change the user's privileges.
 * EXPLAIN PLAN is excluded because it INSERTs into PLAN_TABLE — strict
 * read-only sessions should prefer queryExecute('EXPLAIN PLAN...') only via
 * the dedicated explainPlan handler, which uses a managed STATEMENT_ID. */
export function isReadOnlySafe(kind: SqlKind, sql?: string): boolean {
  if (kind !== "select") return false;
  if (sql && /^EXPLAIN\s+PLAN\b/i.test(stripLeadingComments(sql))) return false;
  return true;
}

/**
 * Returns true if the statement is an UPDATE or DELETE that has no
 * meaningful WHERE clause. Conservative: anything we can't parse cleanly is
 * NOT flagged as unsafe (we don't want to block legitimate work).
 *
 * Known edge cases (not flagged — false negatives, by design):
 *   - Oracle q'[...]' / q'{...}' raw string literals containing the substring
 *     "WHERE". The strip below only handles single/double quoted strings;
 *     a literal like q'[no where here]' will be treated as text, but the
 *     substring "where" inside it could fool the WHERE search. In practice
 *     this is rare in DELETE/UPDATE bodies — and the warning is only a
 *     heuristic, not a hard guard.
 *   - MERGE is not checked here. isMergeSql() handles it separately; on prod
 *     any MERGE enters the unlock flow regardless of ON clause complexity.
 *   - DML wrapped in PL/SQL blocks is filtered out earlier by classifySql().
 *
 * Examples flagged:
 *   DELETE FROM employees
 *   UPDATE employees SET salary = 0
 *   DELETE FROM employees WHERE 1=1
 *   UPDATE employees SET salary = 0 WHERE TRUE
 *
 * Examples not flagged:
 *   DELETE FROM employees WHERE id = 1
 *   UPDATE employees SET salary = 0 WHERE department_id = 50
 *   MERGE INTO ... (always benign)
 *   INSERT ... (no WHERE applies)
 */
export function isUnsafeBulkDml(sql: string): boolean {
  const s = stripLeadingComments(sql)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim();
  const isUpdate = s.startsWith("UPDATE ");
  const isDelete = s.startsWith("DELETE ");
  const isTruncate = s.startsWith("TRUNCATE ");
  if (!isUpdate && !isDelete && !isTruncate) return false;
  if (isTruncate) return true;

  const whereIdx = findToplevelWhere(s);
  if (whereIdx === -1) {
    // No WHERE at all: unsafe.
    return true;
  }
  // Check the WHERE clause for trivially-true predicates.
  const after = s.slice(whereIdx + 5).trim();
  // Strip trailing RETURNING ... etc
  const trimmed = after.split(/\sRETURNING\s|\sWHEN\s/)[0].trim();
  if (trimmed === "1=1" || trimmed === "1 = 1" || trimmed === "TRUE" || trimmed === "(1=1)" || trimmed === "(TRUE)") {
    return true;
  }
  // WHERE EXISTS (SELECT <anything> FROM DUAL) — non-correlated, always true.
  if (/^EXISTS\s*\(\s*SELECT\s+.+\s+FROM\s+DUAL\s*\)/.test(trimmed)) {
    return true;
  }
  return false;
}

/** Returns true if the statement is a MERGE. In prod any MERGE requires an unlock window. */
export function isMergeSql(sql: string): boolean {
  return stripLeadingComments(sql).trimStart().toUpperCase().startsWith("MERGE ");
}

/** Returns true if the statement is a TRUNCATE. */
export function isTruncateSql(sql: string): boolean {
  return stripLeadingComments(sql).trimStart().toUpperCase().startsWith("TRUNCATE ");
}

/** Risk level for DDL statements, used by the DDL confirmation gate (Item #1E). */
export type DdlRiskLevel = "destructive_ddl" | "ddl" | "comment";

const _DESTRUCTIVE_DDL_PATTERNS: readonly RegExp[] = [
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*ALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i,
  /^\s*ALTER\s+TABLE\b[\s\S]*?\bDROP\s+CONSTRAINT\b/i,
  /^\s*ALTER\s+TABLE\b[\s\S]*?\bDROP\s+PARTITION\b/i,
];

const _COMMENT_DDL_PATTERN = /^\s*COMMENT\s+ON\b/i;

/**
 * Sub-classifies a statement already known to be DDL (classifySql returns "ddl").
 * Callers MUST check classifySql() first — passing non-DDL SQL here is undefined behaviour.
 * Returns "comment" for COMMENT ON, "destructive_ddl" for DROP/TRUNCATE/ALTER...DROP,
 * "ddl" for CREATE/ALTER(non-drop)/GRANT/REVOKE/RENAME.
 */
export function classifyDdl(sql: string): DdlRiskLevel {
  if (_COMMENT_DDL_PATTERN.test(sql)) return "comment";
  if (_DESTRUCTIVE_DDL_PATTERNS.some((p) => p.test(sql))) return "destructive_ddl";
  return "ddl";
}

/**
 * Extract the primary target table from a DML statement as UPPERCASE "SCHEMA.TABLE" or "TABLE".
 * Returns empty string when unparseable. Used by the unsafe-DML enforcement layer
 * for staging confirmation prompts and prod unlock-window table matching.
 */
export function extractTableFromSql(sql: string): string {
  const s = stripLeadingComments(sql).replace(/\s+/g, " ").trim().toUpperCase();
  let tail: string;
  if (s.startsWith("UPDATE "))            tail = s.slice(7);
  else if (s.startsWith("DELETE FROM "))  tail = s.slice(12);
  else if (s.startsWith("DELETE "))       tail = s.slice(7);
  else if (s.startsWith("TRUNCATE TABLE ")) tail = s.slice(15);
  else if (s.startsWith("TRUNCATE "))     tail = s.slice(9);
  else if (s.startsWith("MERGE INTO "))   tail = s.slice(11);
  else if (s.startsWith("MERGE "))        tail = s.slice(6);
  else return "";
  tail = tail.trimStart();
  const m = tail.match(/^"?([\w$#]+)"?(?:\."?([\w$#]+)"?)?/);
  if (!m) return "";
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

/** Find the index of the top-level WHERE keyword (not inside parens or quoted). */
function findToplevelWhere(s: string): number {
  let depth = 0;
  let inStr = false;
  let strCh = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === "W" || ch === "w")) {
      if (s.slice(i, i + 5).toUpperCase() === "WHERE" && /\s/.test(s[i - 1] ?? " ") && /\s/.test(s[i + 5] ?? " ")) {
        return i;
      }
    }
  }
  return -1;
}
