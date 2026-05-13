// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-cloud-edition

use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum KeepOpenError {
    Sqlite(rusqlite::Error),
    InvalidArg(String),
}

impl From<rusqlite::Error> for KeepOpenError {
    fn from(e: rusqlite::Error) -> Self {
        KeepOpenError::Sqlite(e)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeepOpenRecord {
    pub connection_id: String,
    pub opened_at: i64,
    pub expires_at: i64,
    pub last_tx_id: Option<String>,
    pub env: String,
}

const VALID_ENVS: &[&str] = &["local", "dev", "staging", "prod"];

pub fn upsert(
    conn: &SqliteConnection,
    connection_id: &str,
    env: &str,
    last_tx_id: Option<&str>,
    opened_at: i64,
    expires_at: i64,
) -> Result<KeepOpenRecord, KeepOpenError> {
    if connection_id.is_empty() {
        return Err(KeepOpenError::InvalidArg("connection_id empty".into()));
    }
    if !VALID_ENVS.contains(&env) {
        return Err(KeepOpenError::InvalidArg(format!("invalid env: {env}")));
    }
    if expires_at <= opened_at {
        return Err(KeepOpenError::InvalidArg(
            "expires_at must be after opened_at".into(),
        ));
    }
    conn.execute(
        "INSERT INTO pending_tx_keep_open \
            (connection_id, opened_at, expires_at, last_tx_id, env) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(connection_id) DO UPDATE SET \
            opened_at = excluded.opened_at, \
            expires_at = excluded.expires_at, \
            last_tx_id = excluded.last_tx_id, \
            env = excluded.env",
        params![connection_id, opened_at, expires_at, last_tx_id, env],
    )?;
    Ok(KeepOpenRecord {
        connection_id: connection_id.to_string(),
        opened_at,
        expires_at,
        last_tx_id: last_tx_id.map(|s| s.to_string()),
        env: env.to_string(),
    })
}

pub fn clear(conn: &SqliteConnection, connection_id: &str) -> Result<(), KeepOpenError> {
    conn.execute(
        "DELETE FROM pending_tx_keep_open WHERE connection_id = ?1",
        params![connection_id],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn list_active(
    conn: &SqliteConnection,
    now_ms: i64,
) -> Result<Vec<KeepOpenRecord>, KeepOpenError> {
    let mut stmt = conn.prepare(
        "SELECT connection_id, opened_at, expires_at, last_tx_id, env \
         FROM pending_tx_keep_open \
         WHERE expires_at > ?1 \
         ORDER BY expires_at ASC",
    )?;
    let rows = stmt.query_map(params![now_ms], |r| {
        Ok(KeepOpenRecord {
            connection_id: r.get(0)?,
            opened_at: r.get(1)?,
            expires_at: r.get(2)?,
            last_tx_id: r.get(3)?,
            env: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn purge_expired(conn: &SqliteConnection, now_ms: i64) -> Result<usize, KeepOpenError> {
    let n = conn.execute(
        "DELETE FROM pending_tx_keep_open WHERE expires_at <= ?1",
        params![now_ms],
    )?;
    Ok(n)
}

#[allow(dead_code)]
pub fn get(
    conn: &SqliteConnection,
    connection_id: &str,
) -> Result<Option<KeepOpenRecord>, KeepOpenError> {
    let row = conn
        .query_row(
            "SELECT connection_id, opened_at, expires_at, last_tx_id, env \
             FROM pending_tx_keep_open WHERE connection_id = ?1",
            params![connection_id],
            |r| {
                Ok(KeepOpenRecord {
                    connection_id: r.get(0)?,
                    opened_at: r.get(1)?,
                    expires_at: r.get(2)?,
                    last_tx_id: r.get(3)?,
                    env: r.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection as SqliteConnection;

    fn open_test_db() -> SqliteConnection {
        let conn = SqliteConnection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE pending_tx_keep_open (
                connection_id TEXT NOT NULL PRIMARY KEY,
                opened_at     INTEGER NOT NULL,
                expires_at    INTEGER NOT NULL,
                last_tx_id    TEXT,
                env           TEXT NOT NULL
                                CHECK (env IN ('local','dev','staging','prod'))
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_and_get_roundtrip() {
        let conn = open_test_db();
        let rec = upsert(&conn, "conn-1", "prod", Some("tx-abc"), 1000, 8200000).unwrap();
        assert_eq!(rec.connection_id, "conn-1");
        let got = get(&conn, "conn-1").unwrap().unwrap();
        assert_eq!(got, rec);
    }

    #[test]
    fn upsert_replaces_existing() {
        let conn = open_test_db();
        upsert(&conn, "conn-1", "dev", Some("tx-1"), 1000, 5000).unwrap();
        let r2 = upsert(&conn, "conn-1", "prod", Some("tx-2"), 6000, 10000).unwrap();
        assert_eq!(r2.env, "prod");
        assert_eq!(r2.last_tx_id, Some("tx-2".into()));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pending_tx_keep_open", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_invalid_env() {
        let conn = open_test_db();
        let err = upsert(&conn, "conn-1", "qa", None, 1000, 2000).unwrap_err();
        assert!(matches!(err, KeepOpenError::InvalidArg(_)));
    }

    #[test]
    fn rejects_inverted_window() {
        let conn = open_test_db();
        let err = upsert(&conn, "conn-1", "prod", None, 5000, 1000).unwrap_err();
        assert!(matches!(err, KeepOpenError::InvalidArg(_)));
    }

    #[test]
    fn list_active_filters_expired() {
        let conn = open_test_db();
        upsert(&conn, "conn-live", "prod", None, 1000, 10000).unwrap();
        upsert(&conn, "conn-dead", "prod", None, 1000, 4000).unwrap();
        let active = list_active(&conn, 5000).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].connection_id, "conn-live");
    }

    #[test]
    fn purge_expired_removes_rows() {
        let conn = open_test_db();
        upsert(&conn, "conn-live", "prod", None, 1000, 10000).unwrap();
        upsert(&conn, "conn-dead", "prod", None, 1000, 4000).unwrap();
        let removed = purge_expired(&conn, 5000).unwrap();
        assert_eq!(removed, 1);
        assert!(get(&conn, "conn-dead").unwrap().is_none());
        assert!(get(&conn, "conn-live").unwrap().is_some());
    }

    #[test]
    fn clear_removes_specific_row() {
        let conn = open_test_db();
        upsert(&conn, "conn-1", "prod", None, 1000, 10000).unwrap();
        upsert(&conn, "conn-2", "dev", None, 1000, 10000).unwrap();
        clear(&conn, "conn-1").unwrap();
        assert!(get(&conn, "conn-1").unwrap().is_none());
        assert!(get(&conn, "conn-2").unwrap().is_some());
    }
}
