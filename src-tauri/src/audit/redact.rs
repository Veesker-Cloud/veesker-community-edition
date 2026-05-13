// Redact known credential patterns from SQL text before writing it to the
// local audit JSONL file at <appData>/audit/<date>.jsonl.
//
// HIGH-001 (audit 2026-04-30) sealed cloud-side redaction in the API; this
// is the matching desktop-side guard. SDR-S-002 (cross-stack review,
// 2026-05-06) flagged this gap — passwords landed in the local audit log
// in cleartext. Defense-in-depth: even if the entry never leaves the
// device, a leaked Application Support directory must not expose creds.
//
// SOURCE OF TRUTH for these patterns: src/lib/services/redactSql.ts.
// Keep this file in sync with the TS mirror and the server-side file.
//
// Known limitation (mirrored from TS): the regex matches keywords inside
// string literals too, causing benign over-redaction. Acceptable for v1 —
// over-redaction is safer than under-redaction.

use regex::Regex;
use std::sync::OnceLock;

// The Rust `regex` crate has no backreferences, so each "quoted string"
// pattern is expressed as an alternation: `'[^']*'|"[^"]*"`. The TS
// source uses `(['"])([^'"]+)\1` to require matching open/close quotes;
// the Rust mirror keeps that semantic via the alternation. Both halves
// disallow the OTHER quote inside, matching the TS behaviour exactly.

fn re_identified_by_values() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)IDENTIFIED\s+BY\s+VALUES\s+(?:'[^']+'|"[^"]+")"#).expect("regex")
    })
}

fn re_identified_by_quoted() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)IDENTIFIED\s+BY\s+(?:'[^']+'|"[^"]+")"#).expect("regex"))
}

// Pattern 3: IDENTIFIED BY <unquoted-identifier>. Rust's regex crate has
// no negative lookahead, so we match liberally and skip via a closure if
// the captured token is `VALUES` (already handled by pattern 1) or
// already-redacted (`***REDACTED...`). By the time this pattern runs,
// patterns 1, 2, and 4 have already processed their cases, so any
// remaining hit is genuinely an unquoted identifier or a leftover marker.
fn re_identified_by_unquoted() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)IDENTIFIED\s+BY\s+([^\s;,)]+)"#).expect("regex"))
}

fn re_identified_globally_as() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)IDENTIFIED\s+GLOBALLY\s+AS\s+(?:'[^']+'|"[^"]+")"#).expect("regex")
    })
}

fn re_password() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\bPASSWORD\s+(?:'[^']+'|"[^"]+")"#).expect("regex"))
}

fn re_bfilename() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)BFILENAME\s*\(\s*(?:'[^']+'|"[^"]+")\s*,\s*(?:'[^']+'|"[^"]+")\s*\)"#)
            .expect("regex")
    })
}

fn re_using_quoted() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)USING\s+(?:'[^']+'|"[^"]+")"#).expect("regex"))
}

/// Replace credential patterns in `sql` with `***REDACTED***` markers.
/// The caller writes the returned string to disk; the original `sql` is
/// untouched.
pub fn redact_sql(sql: &str) -> String {
    // Order matches the TS source of truth so each later pattern sees the
    // text already-cleaned by the earlier ones, avoiding double-replace
    // and accidental over-redaction.
    let mut out = sql.to_string();

    out = re_identified_by_values()
        .replace_all(&out, "IDENTIFIED BY VALUES '***REDACTED***'")
        .into_owned();

    out = re_identified_by_quoted()
        .replace_all(&out, "IDENTIFIED BY '***REDACTED***'")
        .into_owned();

    out = re_identified_globally_as()
        .replace_all(&out, "IDENTIFIED GLOBALLY AS '***REDACTED***'")
        .into_owned();

    // Pattern 3 — unquoted. Skip captures that are:
    //   - `VALUES` (left behind by pattern 1's replacement),
    //   - already-redacted markers,
    //   - a quoted string (pattern 2 already ran and replaced quoted
    //     forms with `'***REDACTED***'`; we must not re-strip the quotes).
    // Anything else is a real bare-identifier credential.
    out = re_identified_by_unquoted()
        .replace_all(&out, |caps: &regex::Captures| {
            let token = &caps[1];
            let first = token.as_bytes().first().copied();
            if token.eq_ignore_ascii_case("VALUES")
                || token.starts_with("***REDACTED")
                || first == Some(b'\'')
                || first == Some(b'"')
            {
                caps[0].to_string()
            } else {
                "IDENTIFIED BY ***REDACTED***".to_string()
            }
        })
        .into_owned();

    out = re_password()
        .replace_all(&out, "PASSWORD '***REDACTED***'")
        .into_owned();

    out = re_bfilename()
        .replace_all(&out, "BFILENAME('***REDACTED***', '***REDACTED***')")
        .into_owned();

    out = re_using_quoted()
        .replace_all(&out, "USING '***REDACTED***'")
        .into_owned();

    out
}

#[cfg(test)]
mod tests {
    use super::redact_sql;

    #[test]
    fn redacts_identified_by_plaintext() {
        let sql = "ALTER USER scott IDENTIFIED BY 'tiger123'";
        let out = redact_sql(sql);
        assert_eq!(out, "ALTER USER scott IDENTIFIED BY '***REDACTED***'");
    }

    #[test]
    fn redacts_identified_by_values() {
        let sql = "CREATE USER hr IDENTIFIED BY VALUES 'S:1234ABCD;T:5678EF00'";
        let out = redact_sql(sql);
        assert_eq!(out, "CREATE USER hr IDENTIFIED BY VALUES '***REDACTED***'");
    }

    #[test]
    fn redacts_identified_by_unquoted_identifier() {
        let sql = "ALTER USER scott IDENTIFIED BY tiger";
        let out = redact_sql(sql);
        assert_eq!(out, "ALTER USER scott IDENTIFIED BY ***REDACTED***");
    }

    #[test]
    fn redacts_identified_globally_as() {
        let sql = "ALTER USER hr IDENTIFIED GLOBALLY AS 'CN=hr,OU=db,O=corp'";
        let out = redact_sql(sql);
        assert_eq!(out, "ALTER USER hr IDENTIFIED GLOBALLY AS '***REDACTED***'");
    }

    #[test]
    fn redacts_password_keyword() {
        let sql = "CREATE DATABASE LINK foo CONNECT TO scott PASSWORD 'tiger'";
        let out = redact_sql(sql);
        assert_eq!(
            out,
            "CREATE DATABASE LINK foo CONNECT TO scott PASSWORD '***REDACTED***'"
        );
    }

    #[test]
    fn redacts_bfilename() {
        let sql = "SELECT BFILENAME('DIR_A', 'secrets.txt') FROM dual";
        let out = redact_sql(sql);
        assert_eq!(
            out,
            "SELECT BFILENAME('***REDACTED***', '***REDACTED***') FROM dual"
        );
    }

    #[test]
    fn redacts_using_clause() {
        let sql =
            "CREATE PUBLIC DATABASE LINK l CONNECT TO scott IDENTIFIED BY 'x' USING 'tns_alias'";
        let out = redact_sql(sql);
        assert!(out.contains("USING '***REDACTED***'"));
        assert!(out.contains("IDENTIFIED BY '***REDACTED***'"));
    }

    #[test]
    fn passthrough_select_unchanged() {
        let sql =
            "SELECT employee_id, first_name, last_name FROM employees WHERE department_id = 10";
        assert_eq!(redact_sql(sql), sql);
    }

    #[test]
    fn does_not_double_redact_already_clean_text() {
        let already = "ALTER USER scott IDENTIFIED BY '***REDACTED***'";
        // Running redact again must keep the same shape (idempotent on
        // the marker — the literal stays quoted-redacted).
        let out = redact_sql(already);
        assert_eq!(out, already);
    }

    #[test]
    fn is_case_insensitive() {
        let sql = "alter user scott identified by 'tiger'";
        let out = redact_sql(sql);
        assert_eq!(out, "alter user scott IDENTIFIED BY '***REDACTED***'");
    }

    #[test]
    fn multiple_credentials_all_redacted() {
        let sql = "ALTER USER a IDENTIFIED BY 'pa' ; ALTER USER b IDENTIFIED BY 'pb'";
        let out = redact_sql(sql);
        assert!(!out.contains("'pa'"));
        assert!(!out.contains("'pb'"));
        assert_eq!(out.matches("***REDACTED***").count(), 2);
    }
}
