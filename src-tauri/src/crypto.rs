// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

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
// F-D-001 (security audit 2026-05-14): previously, when the OS keychain was
// unavailable (headless Linux, broken gnome-keyring, etc.) these helpers
// silently returned a vec![0u8; 32] all-zero key. SQLCipher then opened the
// workspace DB with that publicly-known key, and the audit log encrypted
// JSONL lines with the same zero key — both trivially decryptable by anyone
// reading the file off disk. The functions now return Result and propagate
// keychain failure as KeyringError. The DB open path refuses to proceed.
// The audit-write path falls back to honest plaintext (the read path already
// handles legacy plain-JSON lines) rather than silently emitting
// public-knowledge "encrypted" data.
//
// Note: the audit-cipher-key is INDEPENDENT from the audit-hmac-key
// introduced in Sprint B. The HMAC chain key signs entry bodies for tamper
// detection; the cipher key encrypts the JSONL wire format.

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

/// Errors emitted by the keychain-backed key helpers. Replaces the previous
/// silent-zero-key fallback so callers can decide whether to abort
/// (SQLCipher open path) or emit honest plaintext (audit write path).
#[derive(Debug)]
pub enum KeyringError {
    /// `keyring::Entry::new` failed — the OS keychain service is unreachable
    /// (no D-Bus on Linux, locked DPAPI on Windows, securityd refusal on
    /// unsigned macOS builds, etc.).
    Unavailable(String),
    /// Reading a stored entry succeeded but the stored value is corrupt
    /// (wrong length, non-hex bytes). Treated separately so the caller can
    /// distinguish "first run, never written" from "data drift".
    Corrupt(String),
    /// Persisting a freshly-generated key back to the keychain failed.
    /// Using the key would orphan it (next start can't reload), so we
    /// refuse it.
    Persist(String),
}

impl std::fmt::Display for KeyringError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyringError::Unavailable(s) => write!(f, "OS keychain unavailable: {s}"),
            KeyringError::Corrupt(s) => write!(f, "Stored keychain entry is corrupt: {s}"),
            KeyringError::Persist(s) => write!(f, "Could not persist key to keychain: {s}"),
        }
    }
}

impl std::error::Error for KeyringError {}

/// Returns the SQLCipher master key for `veesker.db`. Generates and
/// persists a fresh 32-byte key on first call.
///
/// Returns `Err(KeyringError)` instead of the previous all-zero fallback.
/// The DB open path must abort (refusing to encrypt with a public key)
/// rather than write a publicly-decryptable workspace to disk.
pub fn get_or_create_db_key() -> Result<Vec<u8>, KeyringError> {
    get_or_create_key(KEY_NAME_DB, "db-master")
}

/// Returns the AES-256-GCM key for audit JSONL lines. Independent from the
/// HMAC chain key (Sprint B): a read-only attacker who steals the JSONL
/// still cannot recover the body without this cipher key, even if the HMAC
/// key has been previously exposed.
///
/// Returns `Err(KeyringError)` instead of the previous all-zero fallback.
/// Audit write callers should fall back to emitting the body as a legacy
/// plain-JSON line (the read path already handles that format) rather than
/// silently encrypting with a public zero key.
pub fn get_or_create_audit_cipher_key() -> Result<Vec<u8>, KeyringError> {
    get_or_create_key(KEY_NAME_AUDIT_CIPHER, "audit-cipher")
}

/// Returns the AES-256-GCM key for command_history rows, or None when the
/// keychain is unavailable. Intentionally does NOT fall back to a zeroed key:
/// a publicly-known zero key provides no protection while making the user
/// believe their history is encrypted. Callers must disable history recording
/// for the session when this returns None.
///
/// Kept as Option-returning for backward compatibility with existing
/// callers that already handle the disabled-history case. The semantics
/// match the new Result-returning helpers above (no zero-key fallback).
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
    // F-D-003: OsRng matches the nonce path elsewhere in this file; thread_rng
    // is technically also CSPRNG via ChaCha12 but tying to OsRng removes any
    // ambiguity about thread-local seed source.
    OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    if entry.set_password(&hex).is_err() {
        eprintln!(
            "command-history-cipher: could not persist key to keychain — history disabled for this session"
        );
        return None;
    }
    Some(bytes)
}

fn get_or_create_key(keychain_name: &str, log_label: &str) -> Result<Vec<u8>, KeyringError> {
    let entry = Entry::new(KEYCHAIN_SERVICE, keychain_name).map_err(|e| {
        eprintln!(
            "{log_label}: keychain unavailable ({e}) — refusing to fall back to a zeroed key"
        );
        KeyringError::Unavailable(e.to_string())
    })?;
    match entry.get_password() {
        Ok(stored) if stored.len() == KEY_HEX_LEN => {
            match (0..KEY_BYTES)
                .map(|i| u8::from_str_radix(&stored[i * 2..i * 2 + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
            {
                Ok(bytes) => Ok(bytes),
                Err(e) => Err(KeyringError::Corrupt(format!(
                    "{log_label} entry contains non-hex byte: {e}"
                ))),
            }
        }
        Ok(_) => Err(KeyringError::Corrupt(format!(
            "{log_label} entry has wrong length"
        ))),
        // First-run path: no stored entry yet, generate one and persist it.
        Err(_) => {
            let mut bytes = vec![0u8; KEY_BYTES];
            // F-D-003: OsRng instead of thread_rng — removes any doubt about
            // thread-local CSPRNG seed source for security-critical key gen.
            OsRng.fill_bytes(&mut bytes);
            let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
            if let Err(e) = entry.set_password(&hex) {
                // Refuse to return an unpersisted key — the next restart
                // wouldn't be able to reload it, leaving every encrypted
                // row/file unrecoverable. Better to fail loudly here.
                return Err(KeyringError::Persist(format!(
                    "{log_label}: {e}"
                )));
            }
            Ok(bytes)
        }
    }
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
    // Defensive: hex output MUST be exactly 64 ASCII hex chars. If a future
    // refactor ever fed a non-32-byte key in, the SQLCipher PRAGMA would
    // accept it silently as a passphrase rather than a blob literal. This
    // assert keeps the splice point honest. (F-D-004 hardening.)
    debug_assert_eq!(hex.len(), 64, "db key hex must be 64 chars");
    debug_assert!(
        hex.chars().all(|c| c.is_ascii_hexdigit()),
        "db key hex must contain only hex digits"
    );
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

    // F-D-001 (security audit 2026-05-14): the public helpers must NEVER
    // return an all-zero key as a silent fallback. If the keychain is
    // available and a key exists, they return Ok(key); otherwise they
    // return Err(KeyringError). The DB open path must propagate the Err
    // rather than encrypt with a zero key.
    //
    // We can't easily test "keychain unavailable" without injecting a
    // platform-specific failure, but we CAN assert that a successful
    // first-call result is never the zero vector — i.e. the OsRng path
    // is exercised.
    #[test]
    fn get_or_create_db_key_returns_random_bytes_not_zero() {
        // This test exercises the real OS keychain. On a developer machine
        // with a working keychain, the call should succeed and the returned
        // key MUST NOT be all-zero. On CI without a keychain, the call
        // returns Err — we accept that too, but if it returns Ok the
        // bytes must be random.
        match super::get_or_create_db_key() {
            Ok(key) => {
                assert_eq!(key.len(), KEY_BYTES);
                assert_ne!(key, vec![0u8; KEY_BYTES], "key must not be all-zero");
            }
            Err(e) => {
                eprintln!("(test) keychain unavailable in this environment: {e}");
            }
        }
    }
}
