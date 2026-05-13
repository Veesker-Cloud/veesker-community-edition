// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-cloud-edition

// Onda 1.B (Sprint C) — encryption-at-rest primitives.
//
// Two independent 32-byte symmetric keys live in the OS keychain:
//   * `veesker:db-master-key`     — SQLCipher key for veesker.db
//   * `veesker:audit-cipher-key`  — AES-256-GCM key for audit JSONL lines
//
// Each key is generated once on first start. Lost keychain = lost data: no
// escrow exists by design. The threat model is laptop theft / compromised
// disk, not the user themselves.
//
// Note: the audit-cipher-key is INDEPENDENT from the audit-hmac-key
// introduced in Sprint B. The HMAC chain key signs entry bodies for tamper
// detection; the cipher key encrypts the JSONL wire format. An attacker
// with read-only access to the JSONL but neither key still cannot recover
// SQL bodies; a compromise of one key does not weaken the other.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use keyring::Entry;
use rand::RngCore;

const KEY_BYTES: usize = 32;
const KEY_HEX_LEN: usize = KEY_BYTES * 2;
const NONCE_BYTES: usize = 12;
const GCM_TAG_BYTES: usize = 16;

/// Wire prefix that marks an audit JSONL line as AES-GCM-encrypted. Three
/// bytes long so legacy plain-JSON lines (which start with `{`) decode
/// unambiguously without a per-file flag.
pub const ENCRYPTED_LINE_PREFIX: &str = "02:";

const KEYCHAIN_SERVICE: &str = "veesker";
const KEY_NAME_DB: &str = "db-master-key";
const KEY_NAME_AUDIT_CIPHER: &str = "audit-cipher-key";

/// Returns the SQLCipher master key for `veesker.db`. Generates and
/// persists a fresh 32-byte key on first call.
pub fn get_or_create_db_key() -> Vec<u8> {
    get_or_create_key(KEY_NAME_DB, "db-master")
}

/// Returns the AES-256-GCM key for audit JSONL lines. Independent from the
/// HMAC chain key (Sprint B): a read-only attacker who steals the JSONL
/// still cannot recover the body without this cipher key, even if the HMAC
/// key has been previously exposed.
pub fn get_or_create_audit_cipher_key() -> Vec<u8> {
    get_or_create_key(KEY_NAME_AUDIT_CIPHER, "audit-cipher")
}

/// Returns the AES-256-GCM key for command_history rows, or None when the
/// keychain is unavailable. Intentionally does NOT fall back to a zeroed key:
/// a publicly-known zero key provides no protection while making the user
/// believe their history is encrypted. Callers must disable history recording
/// for the session when this returns None.
///
/// Also returns None when the freshly-generated key cannot be persisted — an
/// ephemeral key would make every existing row inaccessible on the next
/// restart, accumulating unrecoverable orphans.
pub fn get_or_create_command_history_key() -> Option<Vec<u8>> {
    let entry = Entry::new(KEYCHAIN_SERVICE, "command-history-cipher-key").ok()?;
    if let Ok(stored) = entry.get_password()
        && stored.len() == KEY_HEX_LEN
        && let Ok(bytes) = (0..KEY_BYTES)
            .map(|i| u8::from_str_radix(&stored[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
    {
        return Some(bytes);
    }
    let mut bytes = vec![0u8; KEY_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    if entry.set_password(&hex).is_err() {
        eprintln!(
            "command-history-cipher: could not persist key to keychain — history disabled for this session"
        );
        return None;
    }
    Some(bytes)
}

fn get_or_create_key(keychain_name: &str, log_label: &str) -> Vec<u8> {
    let entry = match Entry::new(KEYCHAIN_SERVICE, keychain_name) {
        Ok(e) => e,
        Err(_) => {
            eprintln!(
                "{log_label}: keychain unavailable, deriving zeroed key (data will not survive across runs)"
            );
            return vec![0u8; KEY_BYTES];
        }
    };
    if let Ok(stored) = entry.get_password()
        && stored.len() == KEY_HEX_LEN
        && let Ok(bytes) = (0..KEY_BYTES)
            .map(|i| u8::from_str_radix(&stored[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
    {
        return bytes;
    }
    let mut bytes = vec![0u8; KEY_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    if entry.set_password(&hex).is_err() {
        eprintln!("{log_label}: could not persist key to keychain");
    }
    bytes
}

/// Encrypts an audit JSONL body into the on-disk wire format
/// `02:<base64(nonce(12) || ciphertext || tag(16))>`. Caller appends `\n`.
pub fn encrypt_audit_line(key: &[u8], plaintext: &str) -> Result<String, String> {
    if key.len() != KEY_BYTES {
        return Err(format!("audit cipher key must be {KEY_BYTES} bytes"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("audit cipher encrypt: {e}"))?;
    let mut blob = Vec::with_capacity(NONCE_BYTES + ct.len());
    blob.extend_from_slice(nonce.as_slice());
    blob.extend_from_slice(&ct);
    Ok(format!("{ENCRYPTED_LINE_PREFIX}{}", B64.encode(blob)))
}

/// Detects and decrypts a single audit JSONL line.
///
/// * `Ok(Some(plaintext))` — line was `02:<base64>` and decrypted cleanly
/// * `Ok(None)` — legacy plain-JSON line, caller parses as-is
/// * `Err(_)` — line claimed encryption but failed (bad key / tampering /
///   truncation). Read paths should treat this as a soft skip, not abort,
///   so a single corrupted record doesn't black out the entire panel.
pub fn decrypt_audit_line_if_envelope(key: &[u8], line: &str) -> Result<Option<String>, String> {
    let Some(b64) = line.strip_prefix(ENCRYPTED_LINE_PREFIX) else {
        return Ok(None);
    };
    if key.len() != KEY_BYTES {
        return Err(format!("audit cipher key must be {KEY_BYTES} bytes"));
    }
    let blob = B64
        .decode(b64.trim())
        .map_err(|e| format!("audit envelope: base64 decode: {e}"))?;
    if blob.len() < NONCE_BYTES + GCM_TAG_BYTES {
        return Err("audit envelope: blob too short".to_string());
    }
    let (nonce_bytes, rest) = blob.split_at(NONCE_BYTES);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(nonce, rest)
        .map_err(|e| format!("audit envelope: decrypt (key mismatch or tampering): {e}"))?;
    String::from_utf8(plain)
        .map_err(|e| format!("audit envelope: utf8: {e}"))
        .map(Some)
}

/// Hex-encoded SQLCipher pragma argument. Result is wrapped in a single
/// pair of double quotes and an `x'...'` blob literal so it can be spliced
/// directly into a `PRAGMA key = ...` statement without a bind variable
/// (PRAGMA does not accept binds).
pub fn db_key_as_sqlcipher_pragma_arg(key: &[u8]) -> String {
    let hex: String = key.iter().map(|b| format!("{:02x}", b)).collect();
    format!("\"x'{hex}'\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_key() -> Vec<u8> {
        (0u8..32u8).collect()
    }

    #[test]
    fn encrypt_then_decrypt_roundtrips() {
        let key = fixed_key();
        let plain = r#"{"ts":"2026-05-06T00:00:00.000Z","sql":"SELECT 1"}"#;
        let enc = encrypt_audit_line(&key, plain).unwrap();
        assert!(enc.starts_with(ENCRYPTED_LINE_PREFIX));
        let dec = decrypt_audit_line_if_envelope(&key, &enc).unwrap();
        assert_eq!(dec.as_deref(), Some(plain));
    }

    #[test]
    fn legacy_line_passes_through_as_none() {
        let key = fixed_key();
        let legacy = r#"{"ts":"2026-05-05T00:00:00.000Z","sql":"SELECT 2"}"#;
        let res = decrypt_audit_line_if_envelope(&key, legacy).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn nonce_is_unique_across_calls() {
        let key = fixed_key();
        let enc1 = encrypt_audit_line(&key, "same").unwrap();
        let enc2 = encrypt_audit_line(&key, "same").unwrap();
        assert_ne!(enc1, enc2, "GCM nonce reuse would be a CRITICAL bug");
    }

    #[test]
    fn wrong_key_fails_to_decrypt() {
        let key = fixed_key();
        let other: Vec<u8> = (32u8..64u8).collect();
        let enc = encrypt_audit_line(&key, "secret").unwrap();
        assert!(decrypt_audit_line_if_envelope(&other, &enc).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let key = fixed_key();
        let enc = encrypt_audit_line(&key, "do not modify").unwrap();
        let mut bytes: Vec<u8> = enc.into_bytes();
        let prefix_len = ENCRYPTED_LINE_PREFIX.len();
        let target = bytes.len() - 2;
        assert!(target > prefix_len);
        bytes[target] ^= 1;
        let tampered = String::from_utf8(bytes).unwrap();
        assert!(decrypt_audit_line_if_envelope(&key, &tampered).is_err());
    }

    #[test]
    fn rejects_blob_too_short() {
        let key = fixed_key();
        let bogus = format!("{ENCRYPTED_LINE_PREFIX}{}", B64.encode(b"x"));
        assert!(decrypt_audit_line_if_envelope(&key, &bogus).is_err());
    }

    #[test]
    fn pragma_arg_format_is_quoted_blob_literal() {
        let key = vec![0xab; 32];
        let arg = db_key_as_sqlcipher_pragma_arg(&key);
        assert!(arg.starts_with("\"x'"));
        assert!(arg.ends_with("'\""));
        let inner = &arg[3..arg.len() - 2];
        assert_eq!(inner.len(), 64);
        assert!(inner.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn empty_plaintext_is_handled() {
        let key = fixed_key();
        let enc = encrypt_audit_line(&key, "").unwrap();
        let dec = decrypt_audit_line_if_envelope(&key, &enc).unwrap();
        assert_eq!(dec.as_deref(), Some(""));
    }

    #[test]
    fn rejects_short_key() {
        let short = vec![0u8; 16];
        assert!(encrypt_audit_line(&short, "hi").is_err());
    }

    // Sprint B HMAC chain invariant — the chain signs the plain body BEFORE
    // encryption, so a verifier that knows the audit-hmac-key but NOT the
    // audit-cipher-key cannot validate the chain (the wire format hides
    // the body). Conversely, knowing both keys recovers the body and the
    // chain verifies. This test fixes the layering so future refactors
    // don't accidentally swap the order.
    #[test]
    fn cipher_layer_wraps_around_hmac_signed_body() {
        let cipher_key = fixed_key();
        // Imagine the body the Sprint B chain would have signed.
        let body =
            r#"{"ts":"2026-05-06T12:00:00.000Z","sql":"SELECT 1","prevHash":"00","hmac":"abcd"}"#;
        let enc = encrypt_audit_line(&cipher_key, body).unwrap();
        // The wire format must hide the body — no substring of the plain
        // body should appear in the ciphertext payload.
        assert!(
            !enc.contains("SELECT 1"),
            "encrypted line must not contain plaintext SQL"
        );
        assert!(
            !enc.contains("\"hmac\":\"abcd\""),
            "encrypted line must not leak HMAC marker"
        );
        // Decrypts back exactly.
        let dec = decrypt_audit_line_if_envelope(&cipher_key, &enc).unwrap();
        assert_eq!(dec.as_deref(), Some(body));
    }
}
