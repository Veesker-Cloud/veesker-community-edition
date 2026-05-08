// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// PII masker for command_history column-level encryption.
// Mirrors sidecar/src/pii.ts in the CL repo — keep pattern lists in sync.
// Source of truth: identical fixture inputs/outputs in both test suites.

use regex::Regex;
use std::sync::OnceLock;

pub const CPF_MARKER:   &str = "⟨CPF_REDACTED⟩";
pub const CNPJ_MARKER:  &str = "⟨CNPJ_REDACTED⟩";
pub const EMAIL_MARKER: &str = "⟨EMAIL_REDACTED⟩";
pub const CC_MARKER:    &str = "⟨CC_REDACTED⟩";
pub const PHONE_MARKER: &str = "⟨PHONE_REDACTED⟩";
pub const RG_MARKER:    &str = "⟨RG_REDACTED⟩";

fn cpf_re()   -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b").unwrap()) }
fn cnpj_re()  -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new(r"\b\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\b").unwrap()) }
fn email_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").unwrap()) }
fn cc_re()    -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new(r"\b\d(?:[ -]?\d){12,18}\b").unwrap()) }
fn phone_re() -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new(r"\(?\d{2}\)?[\s\-]?\d{4,5}[\s\-]?\d{4}\b").unwrap()) }
fn rg_re()    -> &'static Regex { static R: OnceLock<Regex> = OnceLock::new(); R.get_or_init(|| Regex::new(r"\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b").unwrap()) }

/// Masks PII in a SQL string using ⟨TYPE_REDACTED⟩ markers.
/// CNPJ is checked before CPF because both contain digit groups separated by dots,
/// but CNPJ is uniquely identified by the slash before the last segment.
pub fn mask_pii(input: &str) -> String {
    let s = cnpj_re().replace_all(input, CNPJ_MARKER);
    let s = cpf_re().replace_all(&s, CPF_MARKER);
    let s = email_re().replace_all(&s, EMAIL_MARKER);
    let s = cc_re().replace_all(&s, CC_MARKER);
    let s = phone_re().replace_all(&s, PHONE_MARKER);
    rg_re().replace_all(&s, RG_MARKER).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    // SHARED FIXTURES — input/output pairs must match sidecar/src/pii.ts behavior.

    #[test]
    fn masks_cpf() {
        assert_eq!(mask_pii("CPF: 123.456.789-00"), format!("CPF: {CPF_MARKER}"));
    }

    #[test]
    fn masks_cnpj() {
        assert_eq!(mask_pii("CNPJ: 12.345.678/0001-90"), format!("CNPJ: {CNPJ_MARKER}"));
    }

    #[test]
    fn masks_email() {
        assert_eq!(mask_pii("send to user@example.com ok"), format!("send to {EMAIL_MARKER} ok"));
    }

    #[test]
    fn masks_credit_card() {
        assert_eq!(mask_pii("card 4111111111111111 end"), format!("card {CC_MARKER} end"));
    }

    #[test]
    fn masks_br_phone() {
        let result = mask_pii("(11) 99999-9999");
        assert_eq!(result, PHONE_MARKER);
    }

    #[test]
    fn masks_rg() {
        assert_eq!(mask_pii("RG: 12.345.678-9"), format!("RG: {RG_MARKER}"));
    }

    #[test]
    fn sql_with_cpf_in_where_clause() {
        let sql = "SELECT * FROM customers WHERE cpf = '123.456.789-00'";
        let masked = mask_pii(sql);
        assert!(masked.contains(CPF_MARKER), "CPF should be masked");
        assert!(!masked.contains("123.456.789-00"), "raw CPF must not survive");
        assert!(masked.contains("SELECT * FROM customers"), "SQL structure preserved");
    }

    #[test]
    fn no_false_positive_on_plain_sql() {
        let sql = "SELECT id, name, salary FROM employees WHERE dept_id = 50";
        assert_eq!(mask_pii(sql), sql);
    }

    #[test]
    fn cnpj_not_mistaken_for_cpf() {
        let input = "CNPJ: 12.345.678/0001-90";
        let result = mask_pii(input);
        assert!(result.contains(CNPJ_MARKER));
        assert!(!result.contains(CPF_MARKER));
    }
}
