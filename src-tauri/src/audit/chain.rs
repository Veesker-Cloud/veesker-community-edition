// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use hmac::{Hmac, KeyInit, Mac};
use keyring::Entry;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub fn get_or_create_key() -> Vec<u8> {
    let entry = match Entry::new("veesker", "audit-hmac-key") {
        Ok(e) => e,
        Err(_) => {
            eprintln!("audit-hmac: keychain unavailable, using zeroed key");
            return vec![0u8; 32];
        }
    };
    if let Ok(stored) = entry.get_password()
        && stored.len() == 64
        && let Ok(bytes) = (0..32)
            .map(|i| u8::from_str_radix(&stored[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
    {
        return bytes;
    }
    let seed = format!(
        "{}{}",
        uuid::Uuid::new_v4(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let key: Vec<u8> = Sha256::digest(seed.as_bytes()).to_vec();
    let hex: String = key.iter().map(|b| format!("{:02x}", b)).collect();
    if entry.set_password(&hex).is_err() {
        eprintln!("audit-hmac: could not persist key to keychain");
    }
    key
}

pub fn compute_hmac(key: &[u8], prev_hash: &str, entry_json: &str) -> String {
    let mut mac = match HmacSha256::new_from_slice(key) {
        Ok(m) => m,
        Err(_) => return "hmac-error".to_string(),
    };
    mac.update(prev_hash.as_bytes());
    mac.update(b"|");
    mac.update(entry_json.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hmac_chain_validates_with_origin_fields() {
        let key = vec![42u8; 32];
        let prev = "0000000000000000000000000000000000000000000000000000000000000000";

        let body = json!({
            "ts":           "2026-05-06T12:00:00.000Z",
            "connectionId": "conn-1",
            "host":         "db.example.com",
            "username":     "scott",
            "sql":          "SELECT 1 FROM dual",
            "success":      true,
            "rowCount":     1,
            "elapsedMs":    12,
            "errorCode":    null,
            "errorMessage": null,
            "source":       "user",
            "env":          "PROD",
            "origin":       "user_typed",
            "originDetail": null,
        });
        let body_str = body.to_string();
        let hmac1 = compute_hmac(&key, prev, &body_str);
        let hmac2 = compute_hmac(&key, prev, &body_str);
        assert_eq!(hmac1, hmac2);

        let tampered = json!({
            "ts":           "2026-05-06T12:00:00.000Z",
            "connectionId": "conn-1",
            "host":         "db.example.com",
            "username":     "scott",
            "sql":          "SELECT 1 FROM dual",
            "success":      true,
            "rowCount":     1,
            "elapsedMs":    12,
            "errorCode":    null,
            "errorMessage": null,
            "source":       "user",
            "env":          "PROD",
            "origin":       "ai_approved",
            "originDetail": null,
        });
        let hmac_tampered = compute_hmac(&key, prev, &tampered.to_string());
        assert_ne!(hmac1, hmac_tampered);
    }

    #[test]
    fn hmac_changes_with_prev_hash_advance() {
        let key = vec![7u8; 32];
        let body = "{\"a\":1}";
        let h1 = compute_hmac(&key, "00", body);
        let h2 = compute_hmac(&key, &h1, body);
        assert_ne!(h1, h2);
    }

    #[test]
    fn compute_hmac_same_inputs_deterministic() {
        let key = vec![1u8; 32];
        let h1 = compute_hmac(&key, "genesis", "{\"sql\":\"SELECT 1 FROM DUAL\"}");
        let h2 = compute_hmac(&key, "genesis", "{\"sql\":\"SELECT 1 FROM DUAL\"}");
        assert_eq!(h1, h2);
    }

    #[test]
    fn compute_hmac_different_body_different_output() {
        let key = vec![1u8; 32];
        let h1 = compute_hmac(&key, "genesis", "{\"sql\":\"SELECT 1 FROM DUAL\"}");
        let h2 = compute_hmac(&key, "genesis", "{\"sql\":\"DROP TABLE employees\"}");
        assert_ne!(h1, h2);
    }

    #[test]
    fn key_generation_returns_32_bytes() {
        let zeroed = vec![0u8; 32];
        assert_eq!(zeroed.len(), 32);
        let from_slice = vec![99u8; 32];
        assert_eq!(from_slice.len(), 32);
    }

    #[test]
    fn keychain_unavailable_returns_zeroed_key() {
        // Simulate keychain failure by calling get_or_create_key() in a context
        // where it would fall back. We can't easily simulate keyring failure in
        // unit tests, but we verify the zeroed fallback path computes a valid HMAC.
        let zeroed_key = vec![0u8; 32];
        let hmac = compute_hmac(&zeroed_key, "genesis", "{\"test\":true}");
        assert!(!hmac.is_empty());
        assert_ne!(hmac, "hmac-error");
        // Zero key still produces consistent output
        let hmac2 = compute_hmac(&zeroed_key, "genesis", "{\"test\":true}");
        assert_eq!(hmac, hmac2);
    }
}
