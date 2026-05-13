// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-cloud-edition

use rusqlite::{Connection as SqliteConnection, params};
use serde::{Deserialize, Serialize};

use crate::crypto::{ENCRYPTED_LINE_PREFIX, decrypt_audit_line_if_envelope, encrypt_audit_line};
use crate::pii::mask_pii;

#[derive(Debug)]
pub enum CommandHistoryError {
    Sqlite(rusqlite::Error),
    InvalidArg(String),
    Crypto(String),
}

impl From<rusqlite::Error> for CommandHistoryError {
    fn from(e: rusqlite::Error) -> Self {
        CommandHistoryError::Sqlite(e)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub ts: i64,
    pub command: String,
    pub origin: String,
    pub status: String,
    pub duration_ms: Option<i64>,
}

pub struct LoadResult {
    pub entries: Vec<CommandHistoryEntry>,
    pub inaccessible_count: usize,
    /// True when the keychain was unavailable at startup and history is disabled
    /// for this session. No rows were stored or decrypted.
    pub history_disabled: bool,
}

const VALID_ORIGINS: &[&str] = &["user_typed", "script", "paste"];
const VALID_STATUSES: &[&str] = &["ok", "error", "cancelled"];

/// Stores one command history entry. When `cipher_key` is `None` (keychain
/// unavailable), the operation is a silent no-op — nothing is written to the
/// DB. Returning `Ok(0)` signals the row was not stored; all other row IDs
/// start at 1.
pub fn append(
    conn: &SqliteConnection,
    connection_id: &str,
    command: &str,
    origin: &str,
    status: &str,
    duration_ms: Option<i64>,
    cipher_key: Option<&[u8]>,
) -> Result<i64, CommandHistoryError> {
    let Some(key) = cipher_key else {
        return Ok(0);
    };
    if connection_id.is_empty() {
        return Err(CommandHistoryError::InvalidArg(
            "connection_id required".into(),
        ));
    }
    if command.is_empty() {
        return Err(CommandHistoryError::InvalidArg("command required".into()));
    }
    if !VALID_ORIGINS.contains(&origin) {
        return Err(CommandHistoryError::InvalidArg(format!(
            "origin must be one of {VALID_ORIGINS:?}, got '{origin}'"
        )));
    }
    if !VALID_STATUSES.contains(&status) {
        return Err(CommandHistoryError::InvalidArg(format!(
            "status must be one of {VALID_STATUSES:?}, got '{status}'"
        )));
    }
    let masked = mask_pii(command);
    let stored = encrypt_audit_line(key, &masked)
        .map_err(CommandHistoryError::Crypto)?;
    let ts = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO command_history \
         (connection_id, ts, command, origin, status, duration_ms) \
         VALUES (?, ?, ?, ?, ?, ?)",
        params![connection_id, ts, stored, origin, status, duration_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Loads command history entries. When `cipher_key` is `None` (keychain
/// unavailable), returns an empty result with `history_disabled: true`
/// without touching the DB.
pub fn load(
    conn: &SqliteConnection,
    connection_id: &str,
    limit: i64,
    cipher_key: Option<&[u8]>,
) -> Result<LoadResult, CommandHistoryError> {
    let Some(key) = cipher_key else {
        return Ok(LoadResult {
            entries: vec![],
            inaccessible_count: 0,
            history_disabled: true,
        });
    };
    let limit = limit.clamp(1, 1000);
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, ts, command, origin, status, duration_ms \
         FROM command_history \
         WHERE connection_id = ? \
         ORDER BY ts DESC, id DESC \
         LIMIT ?",
    )?;
    let raw_rows = stmt
        .query_map(params![connection_id, limit], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut entries = Vec::with_capacity(raw_rows.len());
    let mut inaccessible_count = 0usize;
    for mut entry in raw_rows {
        if entry.command.starts_with(ENCRYPTED_LINE_PREFIX) {
            match decrypt_audit_line_if_envelope(key, &entry.command) {
                Ok(Some(plain)) => entry.command = plain,
                Ok(None) => {}
                Err(_) => {
                    inaccessible_count += 1;
                    continue;
                }
            }
        }
        entries.push(entry);
    }
    Ok(LoadResult { entries, inaccessible_count, history_disabled: false })
}

/// Encrypts all legacy plaintext rows (those without the `02:` envelope prefix).
/// Called once at startup. Idempotent — already-encrypted rows are skipped.
/// Order: read plaintext → mask PII → encrypt → update.
/// When `cipher_key` is `None`, skips the migration entirely (history disabled).
pub fn encrypt_legacy_rows(
    conn: &SqliteConnection,
    cipher_key: Option<&[u8]>,
) -> Result<usize, CommandHistoryError> {
    let Some(key) = cipher_key else {
        return Ok(0);
    };
    let mut stmt = conn.prepare(
        "SELECT id, command FROM command_history WHERE command NOT LIKE '02:%'",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut count = 0usize;
    for (id, command) in rows {
        let masked = mask_pii(&command);
        let encrypted = encrypt_audit_line(key, &masked)
            .map_err(CommandHistoryError::Crypto)?;
        conn.execute(
            "UPDATE command_history SET command = ? WHERE id = ?",
            params![encrypted, id],
        )?;
        count += 1;
    }
    Ok(count)
}

/// Deletes all rows whose command envelope is present but fails to decrypt.
/// Returns the number of rows deleted. Used to clean up after a keychain loss.
/// When `cipher_key` is `None`, returns 0 (cannot identify inaccessible rows
/// without a key to attempt decryption against).
pub fn clear_inaccessible(
    conn: &SqliteConnection,
    cipher_key: Option<&[u8]>,
) -> Result<i64, CommandHistoryError> {
    let Some(key) = cipher_key else {
        return Ok(0);
    };
    let mut stmt = conn.prepare(
        "SELECT id, command FROM command_history WHERE command LIKE '02:%'",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut delete_ids: Vec<i64> = Vec::new();
    for (id, command) in rows {
        if decrypt_audit_line_if_envelope(key, &command).is_err() {
            delete_ids.push(id);
        }
    }
    let count = delete_ids.len() as i64;
    for id in delete_ids {
        conn.execute("DELETE FROM command_history WHERE id = ?", params![id])?;
    }
    Ok(count)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommandHistoryEntry> {
    Ok(CommandHistoryEntry {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        ts: row.get(2)?,
        command: row.get(3)?,
        origin: row.get(4)?,
        status: row.get(5)?,
        duration_ms: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::init_db;
    use rusqlite::Connection;

    fn fixed_key() -> Vec<u8> {
        (0u8..32u8).collect()
    }

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        c
    }

    #[test]
    fn append_then_load_round_trip() {
        let key = fixed_key();
        let c = fresh();
        let id = append(
            &c,
            "conn-1",
            "select 1 from dual",
            "user_typed",
            "ok",
            Some(12),
            Some(&key),
        )
        .unwrap();
        assert!(id > 0);
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.inaccessible_count, 0);
        assert!(!result.history_disabled);
        assert_eq!(result.entries[0].id, id);
        assert_eq!(result.entries[0].command, "select 1 from dual");
        assert_eq!(result.entries[0].origin, "user_typed");
        assert_eq!(result.entries[0].status, "ok");
        assert_eq!(result.entries[0].duration_ms, Some(12));
    }

    #[test]
    fn stored_command_is_never_plaintext() {
        let key = fixed_key();
        let c = fresh();
        append(&c, "conn-1", "SELECT secret FROM t", "user_typed", "ok", None, Some(&key)).unwrap();
        let raw: String = c
            .query_row(
                "SELECT command FROM command_history LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            raw.starts_with(ENCRYPTED_LINE_PREFIX),
            "stored value must be encrypted; got: {raw}"
        );
        assert!(!raw.contains("SELECT"), "plaintext must not leak into storage");
    }

    #[test]
    fn pii_is_masked_before_encryption() {
        let key = fixed_key();
        let c = fresh();
        append(
            &c,
            "conn-1",
            "SELECT * FROM t WHERE cpf = '123.456.789-00'",
            "user_typed",
            "ok",
            None,
            Some(&key),
        )
        .unwrap();
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert!(
            result.entries[0].command.contains(crate::pii::CPF_MARKER),
            "CPF must be masked in history"
        );
        assert!(!result.entries[0].command.contains("123.456.789-00"));
    }

    #[test]
    fn load_returns_most_recent_first() {
        let key = fixed_key();
        let c = fresh();
        append(&c, "conn-1", "first",  "user_typed", "ok", None, Some(&key)).unwrap();
        append(&c, "conn-1", "second", "user_typed", "ok", None, Some(&key)).unwrap();
        append(&c, "conn-1", "third",  "user_typed", "ok", None, Some(&key)).unwrap();
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 3);
        assert_eq!(result.entries[0].command, "third");
        assert_eq!(result.entries[1].command, "second");
        assert_eq!(result.entries[2].command, "first");
    }

    #[test]
    fn load_isolates_connections() {
        let key = fixed_key();
        let c = fresh();
        append(&c, "conn-1", "a", "user_typed", "ok", None, Some(&key)).unwrap();
        append(&c, "conn-2", "b", "user_typed", "ok", None, Some(&key)).unwrap();
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].command, "a");
    }

    #[test]
    fn append_rejects_empty_connection_id() {
        let key = fixed_key();
        let c = fresh();
        let err = append(&c, "", "x", "user_typed", "ok", None, Some(&key)).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn append_rejects_empty_command() {
        let key = fixed_key();
        let c = fresh();
        let err = append(&c, "conn-1", "", "user_typed", "ok", None, Some(&key)).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn append_rejects_invalid_origin() {
        let key = fixed_key();
        let c = fresh();
        let err = append(&c, "conn-1", "x", "bogus", "ok", None, Some(&key)).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn append_rejects_invalid_status() {
        let key = fixed_key();
        let c = fresh();
        let err = append(&c, "conn-1", "x", "user_typed", "maybe", None, Some(&key)).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn load_clamps_oversized_limit() {
        let key = fixed_key();
        let c = fresh();
        for i in 0..3 {
            append(&c, "conn-1", &format!("cmd{i}"), "user_typed", "ok", None, Some(&key)).unwrap();
        }
        let result = load(&c, "conn-1", 100_000, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 3);
    }

    #[test]
    fn wrong_key_counts_as_inaccessible() {
        let key = fixed_key();
        let other_key: Vec<u8> = (32u8..64u8).collect();
        let c = fresh();
        append(&c, "conn-1", "secret query", "user_typed", "ok", None, Some(&key)).unwrap();
        let result = load(&c, "conn-1", 10, Some(&other_key)).unwrap();
        assert_eq!(result.entries.len(), 0);
        assert_eq!(result.inaccessible_count, 1);
        assert!(!result.history_disabled);
    }

    #[test]
    fn none_key_disables_history() {
        let key = fixed_key();
        let c = fresh();
        // Pre-populate one encrypted row using a real key.
        append(&c, "conn-1", "existing row", "user_typed", "ok", None, Some(&key)).unwrap();
        // Append with None key is a no-op.
        let inserted = append(&c, "conn-1", "new row", "user_typed", "ok", None, None).unwrap();
        assert_eq!(inserted, 0, "None key must not insert anything");
        // Load with None key returns disabled state — does not read DB rows.
        let result = load(&c, "conn-1", 10, None).unwrap();
        assert!(result.history_disabled);
        assert!(result.entries.is_empty());
        assert_eq!(result.inaccessible_count, 0);
        // encrypt_legacy_rows with None is a no-op.
        let migrated = encrypt_legacy_rows(&c, None).unwrap();
        assert_eq!(migrated, 0);
        // clear_inaccessible with None is a no-op.
        let deleted = clear_inaccessible(&c, None).unwrap();
        assert_eq!(deleted, 0);
    }

    #[test]
    fn encrypt_legacy_rows_migrates_plaintext() {
        let key = fixed_key();
        let c = fresh();
        // Insert a legacy plaintext row directly (bypassing the new append path).
        c.execute(
            "INSERT INTO command_history (connection_id, ts, command, origin, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
            params!["conn-1", 1000i64, "old plaintext command", "user_typed", "ok", rusqlite::types::Null],
        ).unwrap();
        let migrated = encrypt_legacy_rows(&c, Some(&key)).unwrap();
        assert_eq!(migrated, 1);
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].command, "old plaintext command");
        assert_eq!(result.inaccessible_count, 0);
    }

    #[test]
    fn encrypt_legacy_rows_masks_pii_before_encrypting() {
        let key = fixed_key();
        let c = fresh();
        c.execute(
            "INSERT INTO command_history (connection_id, ts, command, origin, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
            params!["conn-1", 1000i64, "SELECT * FROM t WHERE cpf = '123.456.789-00'", "user_typed", "ok", rusqlite::types::Null],
        ).unwrap();
        encrypt_legacy_rows(&c, Some(&key)).unwrap();
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert!(result.entries[0].command.contains(crate::pii::CPF_MARKER));
        assert!(!result.entries[0].command.contains("123.456.789-00"));
    }

    #[test]
    fn encrypt_legacy_rows_is_idempotent() {
        let key = fixed_key();
        let c = fresh();
        append(&c, "conn-1", "already encrypted", "user_typed", "ok", None, Some(&key)).unwrap();
        let migrated = encrypt_legacy_rows(&c, Some(&key)).unwrap();
        assert_eq!(migrated, 0, "no rows should be re-migrated");
    }

    #[test]
    fn clear_inaccessible_deletes_undecryptable_rows() {
        let key = fixed_key();
        let other_key: Vec<u8> = (32u8..64u8).collect();
        let c = fresh();
        append(&c, "conn-1", "row encrypted with other key", "user_typed", "ok", None, Some(&other_key)).unwrap();
        append(&c, "conn-1", "row encrypted with correct key", "user_typed", "ok", None, Some(&key)).unwrap();
        let deleted = clear_inaccessible(&c, Some(&key)).unwrap();
        assert_eq!(deleted, 1);
        let result = load(&c, "conn-1", 10, Some(&key)).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].command, "row encrypted with correct key");
    }
}
