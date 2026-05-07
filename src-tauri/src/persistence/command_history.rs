// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use rusqlite::{Connection as SqliteConnection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum CommandHistoryError {
    Sqlite(rusqlite::Error),
    InvalidArg(String),
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

const VALID_ORIGINS: &[&str] = &["user_typed", "script", "paste"];
const VALID_STATUSES: &[&str] = &["ok", "error", "cancelled"];

pub fn append(
    conn: &SqliteConnection,
    connection_id: &str,
    command: &str,
    origin: &str,
    status: &str,
    duration_ms: Option<i64>,
) -> Result<i64, CommandHistoryError> {
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
    let ts = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO command_history \
         (connection_id, ts, command, origin, status, duration_ms) \
         VALUES (?, ?, ?, ?, ?, ?)",
        params![connection_id, ts, command, origin, status, duration_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn load(
    conn: &SqliteConnection,
    connection_id: &str,
    limit: i64,
) -> Result<Vec<CommandHistoryEntry>, CommandHistoryError> {
    let limit = limit.clamp(1, 1000);
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, ts, command, origin, status, duration_ms \
         FROM command_history \
         WHERE connection_id = ? \
         ORDER BY ts DESC, id DESC \
         LIMIT ?",
    )?;
    let rows = stmt
        .query_map(params![connection_id, limit], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        c
    }

    #[test]
    fn append_then_load_round_trip() {
        let c = fresh();
        let id = append(
            &c,
            "conn-1",
            "select 1 from dual",
            "user_typed",
            "ok",
            Some(12),
        )
        .unwrap();
        assert!(id > 0);
        let rows = load(&c, "conn-1", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].command, "select 1 from dual");
        assert_eq!(rows[0].origin, "user_typed");
        assert_eq!(rows[0].status, "ok");
        assert_eq!(rows[0].duration_ms, Some(12));
    }

    #[test]
    fn load_returns_most_recent_first() {
        let c = fresh();
        append(&c, "conn-1", "first", "user_typed", "ok", None).unwrap();
        // ts has millisecond resolution; tie-break must come from id DESC.
        append(&c, "conn-1", "second", "user_typed", "ok", None).unwrap();
        append(&c, "conn-1", "third", "user_typed", "ok", None).unwrap();
        let rows = load(&c, "conn-1", 10).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].command, "third");
        assert_eq!(rows[1].command, "second");
        assert_eq!(rows[2].command, "first");
    }

    #[test]
    fn load_isolates_connections() {
        let c = fresh();
        append(&c, "conn-1", "a", "user_typed", "ok", None).unwrap();
        append(&c, "conn-2", "b", "user_typed", "ok", None).unwrap();
        let rows = load(&c, "conn-1", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "a");
    }

    #[test]
    fn append_rejects_empty_connection_id() {
        let c = fresh();
        let err = append(&c, "", "x", "user_typed", "ok", None).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn append_rejects_empty_command() {
        let c = fresh();
        let err = append(&c, "conn-1", "", "user_typed", "ok", None).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn append_rejects_invalid_origin() {
        let c = fresh();
        let err = append(&c, "conn-1", "x", "bogus", "ok", None).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn append_rejects_invalid_status() {
        let c = fresh();
        let err = append(&c, "conn-1", "x", "user_typed", "maybe", None).unwrap_err();
        assert!(matches!(err, CommandHistoryError::InvalidArg(_)));
    }

    #[test]
    fn load_clamps_oversized_limit() {
        let c = fresh();
        for i in 0..3 {
            append(&c, "conn-1", &format!("cmd{i}"), "user_typed", "ok", None).unwrap();
        }
        let rows = load(&c, "conn-1", 100_000).unwrap();
        assert_eq!(rows.len(), 3);
    }
}
