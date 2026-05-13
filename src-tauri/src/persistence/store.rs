// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Basic,
    Wallet,
}

impl AuthType {
    fn as_db_str(&self) -> &'static str {
        match self {
            AuthType::Basic => "basic",
            AuthType::Wallet => "wallet",
        }
    }
    fn from_db_str(s: &str) -> rusqlite::Result<Self> {
        match s {
            "basic" => Ok(AuthType::Basic),
            "wallet" => Ok(AuthType::Wallet),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown auth_type: {other}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub service_name: Option<String>,
    pub connect_alias: Option<String>,
    pub username: String,
    pub created_at: String,
    pub updated_at: String,
    /// dev / staging / prod / local / null
    pub env: Option<String>,
    /// when true, sidecar refuses DML/DDL on this connection
    pub read_only: bool,
    /// when set, oracledb.callTimeout for the session (ms); 0/None = unlimited
    pub statement_timeout_ms: Option<u32>,
    /// when true, sidecar warns before UPDATE/DELETE without WHERE
    pub warn_unsafe_dml: bool,
    /// when true, frontend runs background EXPLAIN PLAN + stats analysis
    pub auto_perf_analysis: bool,
    /// L1.2 (Sprint C): when true, the Tauri shell's outbound HTTPS commands
    /// (cloud_api_*, auth_token_*, object_version_push, ai_*, embed_*, etc.)
    /// short-circuit with a -32099 error while this connection is active.
    /// Default-on for prod connections, off otherwise.
    pub airgap_mode: bool,
    /// L2.1 PSDPM (PL/SQL Developer Parity Mode): when true, only user-initiated
    /// SQL is allowed against this connection. AI tools, embed batches, and any
    /// non-user RPC origins are blocked. Schema browser still lazy-loads on
    /// expand. Defaults ON for env=prod / env=staging at save.
    pub psdpm_mode: bool,
    /// L3.2 (Onda 3): per-connection auto-EXPLAIN mode.
    /// "manual" | "always" | "when_dml". Default per env at save time:
    /// dev / unspecified → "manual"; staging / prod → "when_dml". NOT a hard-lock.
    pub auto_explain_mode: String,
}

#[derive(Debug)]
pub enum StoreError {
    NotFound,
    Conflict(String),
    Sqlite(rusqlite::Error),
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

const CREATE_CURRENT_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS connections (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    auth_type            TEXT NOT NULL DEFAULT 'basic'
                           CHECK (auth_type IN ('basic', 'wallet')),
    host                 TEXT,
    port                 INTEGER,
    service_name         TEXT,
    connect_alias        TEXT,
    username             TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    env                  TEXT
                           CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod', 'local')),
    read_only            INTEGER NOT NULL DEFAULT 0
                           CHECK (read_only IN (0, 1)),
    statement_timeout_ms INTEGER
                           CHECK (statement_timeout_ms IS NULL OR statement_timeout_ms >= 0),
    warn_unsafe_dml      INTEGER NOT NULL DEFAULT 0
                           CHECK (warn_unsafe_dml IN (0, 1)),
    auto_perf_analysis   INTEGER NOT NULL DEFAULT 1
                           CHECK (auto_perf_analysis IN (0, 1)),
    airgap_mode          INTEGER NOT NULL DEFAULT 0
                           CHECK (airgap_mode IN (0, 1)),
    psdpm_mode           INTEGER NOT NULL DEFAULT 0
                           CHECK (psdpm_mode IN (0, 1)),
    auto_explain_mode    TEXT NOT NULL DEFAULT 'manual'
                           CHECK (auto_explain_mode IN ('manual', 'always', 'when_dml'))
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_name_unique
    ON connections (LOWER(name));
"#;

const MIGRATE_LEGACY_TO_CURRENT: &str = r#"
BEGIN;
CREATE TABLE connections_new (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    auth_type            TEXT NOT NULL DEFAULT 'basic'
                           CHECK (auth_type IN ('basic', 'wallet')),
    host                 TEXT,
    port                 INTEGER,
    service_name         TEXT,
    connect_alias        TEXT,
    username             TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    env                  TEXT
                           CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod', 'local')),
    read_only            INTEGER NOT NULL DEFAULT 0
                           CHECK (read_only IN (0, 1)),
    statement_timeout_ms INTEGER
                           CHECK (statement_timeout_ms IS NULL OR statement_timeout_ms >= 0),
    warn_unsafe_dml      INTEGER NOT NULL DEFAULT 0
                           CHECK (warn_unsafe_dml IN (0, 1)),
    auto_perf_analysis   INTEGER NOT NULL DEFAULT 1
                           CHECK (auto_perf_analysis IN (0, 1)),
    airgap_mode          INTEGER NOT NULL DEFAULT 0
                           CHECK (airgap_mode IN (0, 1)),
    psdpm_mode           INTEGER NOT NULL DEFAULT 0
                           CHECK (psdpm_mode IN (0, 1)),
    auto_explain_mode    TEXT NOT NULL DEFAULT 'manual'
                           CHECK (auto_explain_mode IN ('manual', 'always', 'when_dml'))
);
INSERT INTO connections_new
    (id, name, auth_type, host, port, service_name, connect_alias, username, created_at, updated_at,
     env, read_only, statement_timeout_ms, warn_unsafe_dml, auto_perf_analysis, airgap_mode, psdpm_mode,
     auto_explain_mode)
    SELECT id, name, 'basic', host, port, service_name, NULL, username, created_at, updated_at,
           NULL, 0, NULL, 0, 1, 0, 0, 'manual'
    FROM connections;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;
DROP INDEX IF EXISTS connections_name_unique;
CREATE UNIQUE INDEX connections_name_unique ON connections (LOWER(name));
COMMIT;
"#;

/// Add the four safety columns to a v2-shaped table (post-MIGRATE_LEGACY but
/// before this iteration). Idempotent: only adds the columns that are missing.
fn add_safety_columns_if_missing(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "connections", "env")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN env TEXT \
               CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod', 'local'));",
        )?;
    }
    if !has_column(conn, "connections", "read_only")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 \
               CHECK (read_only IN (0, 1));",
        )?;
    }
    if !has_column(conn, "connections", "statement_timeout_ms")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN statement_timeout_ms INTEGER \
               CHECK (statement_timeout_ms IS NULL OR statement_timeout_ms >= 0);",
        )?;
    }
    if !has_column(conn, "connections", "warn_unsafe_dml")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN warn_unsafe_dml INTEGER NOT NULL DEFAULT 0 \
               CHECK (warn_unsafe_dml IN (0, 1));",
        )?;
    }
    if !has_column(conn, "connections", "auto_perf_analysis")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN auto_perf_analysis INTEGER NOT NULL DEFAULT 1 \
               CHECK (auto_perf_analysis IN (0, 1));",
        )?;
    }
    // L1.2 (Sprint C): per-connection air-gap mode. Default 0 (off); the save
    // path in connections.rs flips it to 1 for any connection tagged env=prod.
    if !has_column(conn, "connections", "airgap_mode")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN airgap_mode INTEGER NOT NULL DEFAULT 0 \
               CHECK (airgap_mode IN (0, 1));",
        )?;
    }
    // L2.1 PSDPM (PL/SQL Developer Parity Mode) — separate migration step.
    if !has_column(conn, "connections", "psdpm_mode")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN psdpm_mode INTEGER NOT NULL DEFAULT 0 \
               CHECK (psdpm_mode IN (0, 1));",
        )?;
    }
    // L3.2 (Onda 3): per-connection auto-EXPLAIN mode. Default 'manual' for
    // existing rows; the save path in connections.rs picks 'when_dml' for
    // staging/prod and 'manual' for dev / unspecified at save time.
    if !has_column(conn, "connections", "auto_explain_mode")? {
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN auto_explain_mode TEXT NOT NULL DEFAULT 'manual' \
               CHECK (auto_explain_mode IN ('manual', 'always', 'when_dml'));",
        )?;
    }
    // Sprint D Onda D.1 — command_history table for the Command Window REPL.
    // Encrypted at rest by SQLCipher (Onda 1.B); no per-row crypto. Stores one
    // row per submitted command line so the user can recall recent inputs with
    // the up arrow inside `xterm.js`. `origin` and `status` are validated by
    // CHECK to keep the schema honest if a future code path tries to insert
    // junk.
    if !table_exists(conn, "command_history")? {
        conn.execute_batch(
            "CREATE TABLE command_history (\
                id            INTEGER PRIMARY KEY AUTOINCREMENT,\
                connection_id TEXT NOT NULL,\
                ts            INTEGER NOT NULL,\
                command       TEXT NOT NULL,\
                origin        TEXT NOT NULL DEFAULT 'user_typed' \
                                CHECK (origin IN ('user_typed', 'script', 'paste')),\
                status        TEXT NOT NULL DEFAULT 'ok' \
                                CHECK (status IN ('ok', 'error', 'cancelled')),\
                duration_ms   INTEGER\
            );\
            CREATE INDEX idx_command_history_conn_ts \
                ON command_history (connection_id, ts DESC);",
        )?;
    }
    // Item #4 Phase C — keep_open marker for connections whose user chose
    // "Manter aberto" in the close-window TX modal. Stores a promise to NOT
    // auto-rollback for `expires_at - opened_at` ms. Phase D reads non-expired
    // rows on app startup, calls connection.txState to confirm Oracle still
    // agrees the TX is alive, and either restores keep_open or banners
    // "session lost". Encrypted at rest by SQLCipher.
    if !table_exists(conn, "pending_tx_keep_open")? {
        conn.execute_batch(
            "CREATE TABLE pending_tx_keep_open (\
                connection_id TEXT NOT NULL PRIMARY KEY,\
                opened_at     INTEGER NOT NULL,\
                expires_at    INTEGER NOT NULL,\
                last_tx_id    TEXT,\
                env           TEXT NOT NULL \
                                CHECK (env IN ('local','dev','staging','prod'))\
            );\
            CREATE INDEX idx_pending_tx_keep_open_expires \
                ON pending_tx_keep_open (expires_at);",
        )?;
    }
    // Security item #1: the env CHECK constraint must include 'sandbox'. SQLite
    // cannot ALTER a CHECK constraint — a full table rebuild is required for
    // Security item #1 (updated): env CHECK must include 'local'. Full table
    // rebuild required — SQLite cannot ALTER a CHECK constraint. Also converts
    // any existing 'sandbox' rows to 'local'.
    if env_check_needs_local_update(conn)? {
        migrate_env_add_local(conn)?;
    }
    // Security item #2: flip warn_unsafe_dml=1 for all staging/prod connections.
    // DEV/LOCAL stay at 0 — prod has runtime enforcement regardless, and frequent
    // modals on dev lead to habituation and disabling the guard.
    migrate_warn_unsafe_dml_for_prod_staging(conn)?;
    Ok(())
}

fn env_check_needs_local_update(conn: &Connection) -> rusqlite::Result<bool> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='connections'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    Ok(!sql.contains("'local'"))
}

fn migrate_env_add_local(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(r#"
        BEGIN;
        CREATE TABLE connections_env_local_mig (
            id                   TEXT PRIMARY KEY,
            name                 TEXT NOT NULL,
            auth_type            TEXT NOT NULL DEFAULT 'basic'
                                   CHECK (auth_type IN ('basic', 'wallet')),
            host                 TEXT,
            port                 INTEGER,
            service_name         TEXT,
            connect_alias        TEXT,
            username             TEXT NOT NULL,
            created_at           TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            env                  TEXT
                                   CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod', 'local')),
            read_only            INTEGER NOT NULL DEFAULT 0
                                   CHECK (read_only IN (0, 1)),
            statement_timeout_ms INTEGER
                                   CHECK (statement_timeout_ms IS NULL OR statement_timeout_ms >= 0),
            warn_unsafe_dml      INTEGER NOT NULL DEFAULT 0
                                   CHECK (warn_unsafe_dml IN (0, 1)),
            auto_perf_analysis   INTEGER NOT NULL DEFAULT 1
                                   CHECK (auto_perf_analysis IN (0, 1)),
            airgap_mode          INTEGER NOT NULL DEFAULT 0
                                   CHECK (airgap_mode IN (0, 1)),
            psdpm_mode           INTEGER NOT NULL DEFAULT 0
                                   CHECK (psdpm_mode IN (0, 1)),
            auto_explain_mode    TEXT NOT NULL DEFAULT 'manual'
                                   CHECK (auto_explain_mode IN ('manual', 'always', 'when_dml'))
        );
        INSERT INTO connections_env_local_mig
            SELECT id, name, auth_type, host, port, service_name, connect_alias, username,
                   created_at, updated_at,
                   CASE WHEN env = 'sandbox' THEN 'local' ELSE env END,
                   read_only, statement_timeout_ms, warn_unsafe_dml,
                   auto_perf_analysis, airgap_mode, psdpm_mode, auto_explain_mode
            FROM connections;
        DROP TABLE connections;
        ALTER TABLE connections_env_local_mig RENAME TO connections;
        DROP INDEX IF EXISTS connections_name_unique;
        CREATE UNIQUE INDEX connections_name_unique ON connections (LOWER(name));
        COMMIT;
    "#)
}

/// Security item #2: enable warn_unsafe_dml for all staging/prod connections.
/// Idempotent — runs on every startup but only updates rows where the flag is
/// still 0 and env is staging or prod. DEV/LOCAL are intentionally left alone.
fn migrate_warn_unsafe_dml_for_prod_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE connections SET warn_unsafe_dml = 1 \
         WHERE env IN ('staging', 'prod') AND warn_unsafe_dml = 0",
        [],
    )?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(names.iter().any(|n| n == column))
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")?;
    stmt.exists(params![table])
}

pub fn init_db(conn: &Connection) -> Result<(), StoreError> {
    if table_exists(conn, "connections")? && !has_column(conn, "connections", "auth_type")? {
        conn.execute_batch(MIGRATE_LEGACY_TO_CURRENT)?;
    } else {
        conn.execute_batch(CREATE_CURRENT_SCHEMA)?;
    }
    // Safety columns added after auth_type — bring older v2 schemas forward.
    add_safety_columns_if_missing(conn)?;
    Ok(())
}

pub fn create(conn: &Connection, row: &ConnectionRow) -> Result<(), StoreError> {
    let res = conn.execute(
        "INSERT INTO connections \
         (id, name, auth_type, host, port, service_name, connect_alias, username, created_at, updated_at, \
          env, read_only, statement_timeout_ms, warn_unsafe_dml, auto_perf_analysis, airgap_mode, psdpm_mode, \
          auto_explain_mode) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            row.id,
            row.name,
            row.auth_type.as_db_str(),
            row.host,
            row.port,
            row.service_name,
            row.connect_alias,
            row.username,
            row.created_at,
            row.updated_at,
            row.env,
            row.read_only as i32,
            row.statement_timeout_ms,
            row.warn_unsafe_dml as i32,
            row.auto_perf_analysis as i32,
            row.airgap_mode as i32,
            row.psdpm_mode as i32,
            row.auto_explain_mode,
        ],
    );
    match res {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(StoreError::Conflict(format!(
                "name '{}' already in use",
                row.name
            )))
        }
        Err(e) => Err(StoreError::Sqlite(e)),
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRow> {
    let auth: String = row.get(2)?;
    Ok(ConnectionRow {
        id: row.get(0)?,
        name: row.get(1)?,
        auth_type: AuthType::from_db_str(&auth)?,
        host: row.get(3)?,
        port: row.get::<_, Option<i64>>(4)?.map(|n| n as u16),
        service_name: row.get(5)?,
        connect_alias: row.get(6)?,
        username: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        env: row.get(10)?,
        read_only: row.get::<_, i64>(11)? != 0,
        statement_timeout_ms: row.get::<_, Option<i64>>(12)?.map(|n| n as u32),
        warn_unsafe_dml: row.get::<_, i64>(13)? != 0,
        auto_perf_analysis: row.get::<_, i64>(14)? != 0,
        airgap_mode: row.get::<_, i64>(15)? != 0,
        psdpm_mode: row.get::<_, i64>(16)? != 0,
        auto_explain_mode: row.get(17)?,
    })
}

const SELECT_COLS: &str = "id, name, auth_type, host, port, service_name, connect_alias, username, created_at, updated_at, \
     env, read_only, statement_timeout_ms, warn_unsafe_dml, auto_perf_analysis, airgap_mode, psdpm_mode, auto_explain_mode";

pub fn list(conn: &Connection) -> Result<Vec<ConnectionRow>, StoreError> {
    let sql = format!("SELECT {SELECT_COLS} FROM connections ORDER BY LOWER(name)");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], map_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<ConnectionRow>, StoreError> {
    let sql = format!("SELECT {SELECT_COLS} FROM connections WHERE id = ?");
    let mut stmt = conn.prepare(&sql)?;
    let row = stmt.query_row(params![id], map_row).optional()?;
    Ok(row)
}

pub fn update(conn: &Connection, row: &ConnectionRow) -> Result<(), StoreError> {
    let res = conn.execute(
        "UPDATE connections SET \
         name = ?, auth_type = ?, host = ?, port = ?, service_name = ?, \
         connect_alias = ?, username = ?, updated_at = ?, \
         env = ?, read_only = ?, statement_timeout_ms = ?, warn_unsafe_dml = ?, \
         auto_perf_analysis = ?, airgap_mode = ?, psdpm_mode = ?, auto_explain_mode = ? \
         WHERE id = ?",
        params![
            row.name,
            row.auth_type.as_db_str(),
            row.host,
            row.port,
            row.service_name,
            row.connect_alias,
            row.username,
            row.updated_at,
            row.env,
            row.read_only as i32,
            row.statement_timeout_ms,
            row.warn_unsafe_dml as i32,
            row.auto_perf_analysis as i32,
            row.airgap_mode as i32,
            row.psdpm_mode as i32,
            row.auto_explain_mode,
            row.id
        ],
    );
    match res {
        Ok(0) => Err(StoreError::NotFound),
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(StoreError::Conflict(format!(
                "name '{}' already in use",
                row.name
            )))
        }
        Err(e) => Err(StoreError::Sqlite(e)),
    }
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), StoreError> {
    let n = conn.execute("DELETE FROM connections WHERE id = ?", params![id])?;
    if n == 0 {
        Err(StoreError::NotFound)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        c
    }

    fn sample(id: &str, name: &str) -> ConnectionRow {
        ConnectionRow {
            id: id.into(),
            name: name.into(),
            auth_type: AuthType::Basic,
            host: Some("localhost".into()),
            port: Some(1521),
            service_name: Some("FREEPDB1".into()),
            connect_alias: None,
            username: "pdbadmin".into(),
            created_at: "2026-04-20T00:00:00Z".into(),
            updated_at: "2026-04-20T00:00:00Z".into(),
            env: None,
            read_only: false,
            statement_timeout_ms: None,
            warn_unsafe_dml: false,
            auto_perf_analysis: true,
            airgap_mode: false,
            psdpm_mode: false,
            auto_explain_mode: "manual".into(),
        }
    }

    #[test]
    fn init_is_idempotent() {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        init_db(&c).unwrap();
    }

    #[test]
    fn create_then_list_returns_one() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        let rows = list(&c).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "Alpha");
    }

    #[test]
    fn list_orders_by_name_case_insensitive() {
        let c = fresh();
        create(&c, &sample("a", "zeta")).unwrap();
        create(&c, &sample("b", "Alpha")).unwrap();
        create(&c, &sample("c", "mike")).unwrap();
        let names: Vec<_> = list(&c).unwrap().into_iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["Alpha", "mike", "zeta"]);
    }

    #[test]
    fn get_returns_none_for_unknown_id() {
        let c = fresh();
        assert!(get(&c, "missing").unwrap().is_none());
    }

    #[test]
    fn get_returns_row_for_known_id() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(row.host.as_deref(), Some("localhost"));
        assert_eq!(row.port, Some(1521));
    }

    #[test]
    fn create_with_duplicate_name_returns_conflict() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        let err = create(&c, &sample("b", "Alpha")).unwrap_err();
        assert!(matches!(err, StoreError::Conflict(_)));
    }

    #[test]
    fn create_with_duplicate_name_case_insensitive_returns_conflict() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        let err = create(&c, &sample("b", "alpha")).unwrap_err();
        assert!(matches!(err, StoreError::Conflict(_)));
    }

    #[test]
    fn update_changes_fields_and_bumps_updated_at() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        let mut row = get(&c, "a").unwrap().unwrap();
        row.port = Some(1599);
        row.updated_at = "2026-05-01T00:00:00Z".into();
        update(&c, &row).unwrap();
        let after = get(&c, "a").unwrap().unwrap();
        assert_eq!(after.port, Some(1599));
        assert_eq!(after.updated_at, "2026-05-01T00:00:00Z");
    }

    #[test]
    fn update_unknown_id_returns_not_found() {
        let c = fresh();
        let err = update(&c, &sample("ghost", "Ghost")).unwrap_err();
        assert!(matches!(err, StoreError::NotFound));
    }

    #[test]
    fn delete_removes_row() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        delete(&c, "a").unwrap();
        assert!(get(&c, "a").unwrap().is_none());
    }

    #[test]
    fn delete_unknown_id_returns_not_found() {
        let c = fresh();
        let err = delete(&c, "ghost").unwrap_err();
        assert!(matches!(err, StoreError::NotFound));
    }

    #[test]
    fn migration_adds_columns_to_legacy_schema() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                service_name TEXT NOT NULL,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX connections_name_unique ON connections (LOWER(name));
            INSERT INTO connections VALUES
                ('legacy-1', 'Legacy', 'localhost', 1521, 'FREEPDB1', 'admin', '2026-04-20T00:00:00Z', '2026-04-20T00:00:00Z');",
        )
        .unwrap();

        init_db(&c).unwrap();

        let cols: Vec<String> = c
            .prepare("PRAGMA table_info(connections)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(cols.contains(&"auth_type".to_string()));
        assert!(cols.contains(&"connect_alias".to_string()));

        let row = get(&c, "legacy-1").unwrap().unwrap();
        assert_eq!(row.auth_type, AuthType::Basic);
        assert_eq!(row.host.as_deref(), Some("localhost"));
        assert_eq!(row.connect_alias, None);
    }

    #[test]
    fn migration_is_idempotent() {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        init_db(&c).unwrap();
        init_db(&c).unwrap();
    }

    #[test]
    fn create_wallet_row_then_get() {
        let c = fresh();
        let row = ConnectionRow {
            id: "w1".into(),
            name: "Wallet One".into(),
            auth_type: AuthType::Wallet,
            host: None,
            port: None,
            service_name: None,
            connect_alias: Some("mydb_high".into()),
            username: "admin".into(),
            created_at: "2026-04-21T00:00:00Z".into(),
            updated_at: "2026-04-21T00:00:00Z".into(),
            env: None,
            read_only: false,
            statement_timeout_ms: None,
            warn_unsafe_dml: false,
            auto_perf_analysis: true,
            airgap_mode: false,
            psdpm_mode: false,
            auto_explain_mode: "manual".into(),
        };
        create(&c, &row).unwrap();
        let got = get(&c, "w1").unwrap().unwrap();
        assert_eq!(got.auth_type, AuthType::Wallet);
        assert_eq!(got.connect_alias.as_deref(), Some("mydb_high"));
        assert!(got.host.is_none());
        assert!(got.port.is_none());
    }

    #[test]
    fn safety_fields_round_trip() {
        let c = fresh();
        let mut row = sample("s1", "Safe");
        row.env = Some("prod".into());
        row.read_only = true;
        row.statement_timeout_ms = Some(30_000);
        row.warn_unsafe_dml = true;
        create(&c, &row).unwrap();
        let got = get(&c, "s1").unwrap().unwrap();
        assert_eq!(got.env.as_deref(), Some("prod"));
        assert!(got.read_only);
        assert_eq!(got.statement_timeout_ms, Some(30_000));
        assert!(got.warn_unsafe_dml);
    }

    #[test]
    fn migration_adds_safety_columns_to_v2_schema() {
        // Simulate a DB that already migrated to auth_type but predates safety columns.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                auth_type TEXT NOT NULL DEFAULT 'basic'
                  CHECK (auth_type IN ('basic', 'wallet')),
                host TEXT,
                port INTEGER,
                service_name TEXT,
                connect_alias TEXT,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX connections_name_unique ON connections (LOWER(name));
            INSERT INTO connections (id, name, auth_type, host, port, service_name, username, created_at, updated_at)
                VALUES ('v2-1', 'V2', 'basic', 'h', 1521, 'svc', 'u', '2026-04-22T00:00:00Z', '2026-04-22T00:00:00Z');",
        )
        .unwrap();

        init_db(&c).unwrap();

        let row = get(&c, "v2-1").unwrap().unwrap();
        assert_eq!(row.env, None);
        assert!(!row.read_only);
        assert_eq!(row.statement_timeout_ms, None);
        assert!(!row.warn_unsafe_dml);
    }

    #[test]
    fn safety_fields_default_to_safe_on_create() {
        let c = fresh();
        create(&c, &sample("a", "Alpha")).unwrap();
        let got = get(&c, "a").unwrap().unwrap();
        assert_eq!(got.env, None);
        assert!(!got.read_only);
        assert_eq!(got.statement_timeout_ms, None);
        assert!(!got.warn_unsafe_dml);
    }

    #[test]
    fn migration_adds_auto_perf_analysis_column() {
        // V3 schema (post-safety-flags) without auto_perf_analysis.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                auth_type TEXT NOT NULL DEFAULT 'basic',
                host TEXT, port INTEGER, service_name TEXT, connect_alias TEXT,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                env TEXT, read_only INTEGER NOT NULL DEFAULT 0,
                statement_timeout_ms INTEGER, warn_unsafe_dml INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX connections_name_unique ON connections (LOWER(name));
            INSERT INTO connections
                (id, name, auth_type, host, port, service_name, username, created_at, updated_at)
                VALUES ('v3-1', 'V3', 'basic', 'h', 1521, 'svc', 'u',
                        '2026-04-25T00:00:00Z', '2026-04-25T00:00:00Z');",
        )
        .unwrap();

        init_db(&c).unwrap();

        let row = get(&c, "v3-1").unwrap().unwrap();
        assert!(row.auto_perf_analysis, "default should be true");
    }

    #[test]
    fn invalid_env_value_rejected() {
        let c = fresh();
        let mut row = sample("a", "Alpha");
        row.env = Some("production".into()); // not in CHECK list
        // SQLite CHECK violation surfaces as ConstraintViolation, which our
        // create() helper currently maps to Conflict (originally meant for the
        // unique-name index). Either variant is acceptable — the point is that
        // an invalid env value cannot be persisted.
        assert!(create(&c, &row).is_err());
    }

    #[test]
    fn airgap_field_round_trip() {
        let c = fresh();
        let mut row = sample("ag1", "AirGapped");
        row.airgap_mode = true;
        create(&c, &row).unwrap();
        let got = get(&c, "ag1").unwrap().unwrap();
        assert!(got.airgap_mode);
    }

    #[test]
    fn psdpm_mode_round_trips() {
        let c = fresh();
        let mut row = sample("p1", "Psdpm");
        row.psdpm_mode = true;
        create(&c, &row).unwrap();
        let got = get(&c, "p1").unwrap().unwrap();
        assert!(got.psdpm_mode, "psdpm_mode should round-trip true");

        let mut updated = got;
        updated.psdpm_mode = false;
        updated.updated_at = "2026-05-06T00:00:00Z".into();
        update(&c, &updated).unwrap();
        let after = get(&c, "p1").unwrap().unwrap();
        assert!(!after.psdpm_mode, "psdpm_mode should round-trip false");
    }

    #[test]
    fn auto_explain_mode_round_trips() {
        let c = fresh();
        let mut row = sample("a", "Alpha");
        row.auto_explain_mode = "always".into();
        create(&c, &row).unwrap();
        let got = list(&c).unwrap().pop().unwrap();
        assert_eq!(got.auto_explain_mode, "always");

        let mut updated = got;
        updated.auto_explain_mode = "when_dml".into();
        update(&c, &updated).unwrap();
        let after = get(&c, "a").unwrap().unwrap();
        assert_eq!(after.auto_explain_mode, "when_dml");
    }

    #[test]
    fn auto_explain_mode_defaults_to_manual_on_old_rows() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                auth_type TEXT NOT NULL DEFAULT 'basic',
                host TEXT, port INTEGER, service_name TEXT, connect_alias TEXT,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                env TEXT, read_only INTEGER NOT NULL DEFAULT 0,
                statement_timeout_ms INTEGER, warn_unsafe_dml INTEGER NOT NULL DEFAULT 0,
                auto_perf_analysis INTEGER NOT NULL DEFAULT 1,
                airgap_mode INTEGER NOT NULL DEFAULT 0,
                psdpm_mode INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO connections (id, name, auth_type, username, created_at, updated_at)
              VALUES ('a', 'Alpha', 'basic', 'pdbadmin', '2026-04-20T00:00:00Z', '2026-04-20T00:00:00Z');"
        ).unwrap();
        init_db(&c).unwrap();
        let row = get(&c, "a").unwrap().unwrap();
        assert_eq!(
            row.auto_explain_mode, "manual",
            "auto_explain_mode column should default to 'manual' on legacy rows"
        );
    }

    #[test]
    fn migration_creates_command_history_table() {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        assert!(table_exists(&c, "command_history").unwrap());

        let cols: Vec<String> = c
            .prepare("PRAGMA table_info(command_history)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in [
            "id",
            "connection_id",
            "ts",
            "command",
            "origin",
            "status",
            "duration_ms",
        ] {
            assert!(
                cols.iter().any(|n| n == expected),
                "missing column {expected} in command_history (got {cols:?})"
            );
        }

        // The composite (connection_id, ts DESC) index is the only access path
        // the REPL relies on, so make sure it really exists.
        let idx_count: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master \
                 WHERE type = 'index' AND name = 'idx_command_history_conn_ts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            idx_count, 1,
            "expected idx_command_history_conn_ts to exist"
        );

        // CHECK constraints must reject bogus origin/status values.
        let bad_origin = c.execute(
            "INSERT INTO command_history (connection_id, ts, command, origin, status) \
             VALUES ('c1', 0, 'x', 'bogus', 'ok')",
            [],
        );
        assert!(bad_origin.is_err(), "origin CHECK should reject 'bogus'");

        let bad_status = c.execute(
            "INSERT INTO command_history (connection_id, ts, command, origin, status) \
             VALUES ('c1', 0, 'x', 'user_typed', 'maybe')",
            [],
        );
        assert!(bad_status.is_err(), "status CHECK should reject 'maybe'");

        // A round-trip with defaults for origin/status and a NULL duration_ms
        // should succeed and read back identically.
        c.execute(
            "INSERT INTO command_history (connection_id, ts, command) \
             VALUES ('c1', 1700000000000, 'select 1 from dual')",
            [],
        )
        .unwrap();
        let (origin, status, duration): (String, String, Option<i64>) = c
            .query_row(
                "SELECT origin, status, duration_ms FROM command_history WHERE connection_id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(origin, "user_typed");
        assert_eq!(status, "ok");
        assert!(duration.is_none());
    }

    #[test]
    fn migration_adds_safety_columns_to_v4_schema() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                auth_type TEXT NOT NULL DEFAULT 'basic',
                host TEXT, port INTEGER, service_name TEXT, connect_alias TEXT,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                env TEXT, read_only INTEGER NOT NULL DEFAULT 0,
                statement_timeout_ms INTEGER, warn_unsafe_dml INTEGER NOT NULL DEFAULT 0,
                auto_perf_analysis INTEGER NOT NULL DEFAULT 1
            );
            CREATE UNIQUE INDEX connections_name_unique ON connections (LOWER(name));
            INSERT INTO connections
                (id, name, auth_type, host, port, service_name, username, created_at, updated_at)
                VALUES ('v4-1', 'V4', 'basic', 'h', 1521, 'svc', 'u',
                        '2026-05-06T00:00:00Z', '2026-05-06T00:00:00Z');",
        )
        .unwrap();

        init_db(&c).unwrap();

        let row = get(&c, "v4-1").unwrap().unwrap();
        assert!(!row.airgap_mode, "airgap default should be false");
        assert!(!row.psdpm_mode, "psdpm default should be false");
    }
}
