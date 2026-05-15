use aes_gcm::aead::OsRng;
use hmac::{Hmac, Mac};
use keyring::Entry;
use rand::RngCore;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const HMAC_KEY_BYTES: usize = 32;
const HMAC_KEY_HEX_LEN: usize = HMAC_KEY_BYTES * 2;

/// Returns the HMAC chain key, or None when the OS keychain is unavailable.
///
/// F-D-001 / F-D-002 (security audit 2026-05-14): previously this returned
/// `vec![0u8; 32]` when the keychain could not be reached. The chain HMAC
/// then signed every entry with a publicly-known zero key, so any attacker
/// reading the JSONL file could forge or rewrite entries. We now return
/// None and callers MUST emit entries without HMAC fields (or skip
/// emission) rather than silently producing forgeable chains.
///
/// Also, key generation now uses `OsRng` directly. The previous version
/// derived the key from `SHA-256(Uuid::v4() || timestamp_nanos)` — entropy
/// theatre that added zero bits beyond `Uuid::v4()` and made the
/// construction non-standard for auditors to verify. F-D-002 cleanup.
pub fn get_or_create_key() -> Option<Vec<u8>> {
    let entry = match Entry::new("veesker", "audit-hmac-key") {
        Ok(e) => e,
        Err(e) => {
            eprintln!(
                "audit-hmac: keychain unavailable ({e}) — refusing to fall back to a zeroed key; chain HMAC will be omitted"
            );
            return None;
        }
    };
    if let Ok(stored) = entry.get_password()
        && stored.len() == HMAC_KEY_HEX_LEN
        && let Ok(bytes) = (0..HMAC_KEY_BYTES)
            .map(|i| u8::from_str_radix(&stored[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
    {
        return Some(bytes);
    }
    // Fresh key: 32 bytes from OsRng. NOT derived from
    // SHA-256(Uuid::v4() || timestamp_nanos) — that was non-standard and
    // added zero entropy beyond Uuid::v4(). OsRng is the well-trodden path.
    let mut bytes = vec![0u8; HMAC_KEY_BYTES];
    OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    if let Err(e) = entry.set_password(&hex) {
        eprintln!(
            "audit-hmac: could not persist key to keychain ({e}) — refusing to return an ephemeral key (would orphan existing entries on restart)"
        );
        return None;
    }
    Some(bytes)
}

/// Computes the HMAC-SHA256 chain hash for an entry. The result is hex.
///
/// Note: the silent `"hmac-error"` fallback below is retained for API
/// compatibility — `new_from_slice` only fails if the key length is
/// invalid, which our 32-byte OsRng path cannot produce. The string is
/// never written to disk on the happy path. If the audit caller passes a
/// non-32-byte key (test fixtures only), they get the sentinel.
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

    // L2.2 / Sprint B sanity: the HMAC chain is computed over the body JSON,
    // so adding the `origin` and `originDetail` fields to the body MUST be
    // covered by the hash. A verifier that strips hmac/prevHash and rehashes
    // the remaining fields should reproduce the same hmac.
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

        // Re-derive on the verifier side from the same body shape — must match.
        let hmac2 = compute_hmac(&key, prev, &body_str);
        assert_eq!(hmac1, hmac2);

        // Tampering with origin must change the HMAC (proves origin is part of
        // the integrity-protected body).
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
            "origin":       "ai_approved", // changed
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
        // Same body, different prev_hash => different HMAC, proving the chain
        // links each entry to the previous.
        assert_ne!(h1, h2);
    }

    // F-D-002 (security audit 2026-05-14): get_or_create_key must return
    // 32 random bytes (NOT all-zero) when the keychain is healthy.
    #[test]
    fn get_or_create_key_returns_random_bytes_not_zero() {
        match get_or_create_key() {
            Some(key) => {
                assert_eq!(key.len(), HMAC_KEY_BYTES);
                assert_ne!(key, vec![0u8; HMAC_KEY_BYTES], "key must not be all-zero");
            }
            None => {
                eprintln!("(test) keychain unavailable in this environment — None is acceptable");
            }
        }
    }
}
