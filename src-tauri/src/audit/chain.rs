use hmac::{Hmac, Mac};
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
}
