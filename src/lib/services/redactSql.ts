// HIGH-001 (audit 2026-04-30): redact known credential patterns from SQL text
// before uploading to the audit log. Defense-in-depth: server redacts too,
// but the client redacting first means credentials never leave the desktop.
//
// SOURCE OF TRUTH for these patterns: keep this file in sync with
// veesker-cloud/server/src/lib/redact-sql.ts.
//
// Known limitation: the regex matches keywords inside string literals too,
// causing benign over-redaction. Acceptable for v1 — over-redaction is safer
// than under-redaction. v2 can use a SQL tokenizer.

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Oracle: IDENTIFIED BY VALUES 'verifier-hash'
  [/IDENTIFIED\s+BY\s+VALUES\s+(['"])([^'"]+)\1/gi, "IDENTIFIED BY VALUES '***REDACTED***'"],
  // Oracle: IDENTIFIED BY 'plaintext'
  [/IDENTIFIED\s+BY\s+(['"])([^'"]+)\1/gi, "IDENTIFIED BY '***REDACTED***'"],
  // Oracle: IDENTIFIED BY <unquoted-identifier>. Negative lookahead avoids
  // re-redacting VALUES (already handled) and already-redacted markers.
  [/IDENTIFIED\s+BY\s+(?!VALUES\b)(?!\*\*\*REDACTED)([^\s;,)]+)/gi, "IDENTIFIED BY ***REDACTED***"],
  // Oracle: IDENTIFIED GLOBALLY AS 'CN=...' (LDAP DN — sensitive)
  [/IDENTIFIED\s+GLOBALLY\s+AS\s+(['"])([^'"]+)\1/gi, "IDENTIFIED GLOBALLY AS '***REDACTED***'"],
  // Generic PASSWORD '...' (DB Link, profile, etc.)
  [/\bPASSWORD\s+(['"])([^'"]+)\1/gi, "PASSWORD '***REDACTED***'"],
  // BFILE / BFILENAME — file paths can be sensitive
  [
    /BFILENAME\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)/gi,
    "BFILENAME('***REDACTED***', '***REDACTED***')",
  ],
  // CONNECT BY .. USING 'creds'
  [/USING\s+(['"])([^'"]+)\1/gi, "USING '***REDACTED***'"],
];

export function redactSql(sql: string): { redacted: string; matched: boolean } {
  let result = sql;
  let matched = false;
  for (const [re, replacement] of REDACTION_PATTERNS) {
    // Note: do NOT use re.test() here — the /g flag keeps lastIndex state
    // across calls, leading to false negatives when redactSql is invoked
    // multiple times. .replace() resets lastIndex internally.
    const before = result;
    result = result.replace(re, replacement);
    if (result !== before) matched = true;
  }
  return { redacted: result, matched };
}
