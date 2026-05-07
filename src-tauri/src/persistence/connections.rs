// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::Connection as SqliteConnection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{history, object_versions, secrets, store, tnsnames, wallet};
use store::{AuthType, ConnectionRow, StoreError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSafety {
    /// "dev" | "staging" | "prod" | None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    pub read_only: bool,
    /// per-statement timeout in milliseconds (None / 0 = no timeout)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_timeout_ms: Option<u32>,
    /// when true, warn before DML without WHERE
    pub warn_unsafe_dml: bool,
    /// when true, frontend runs background EXPLAIN PLAN + stats analysis
    pub auto_perf_analysis: bool,
    /// L1.2 (Sprint C): when true, all renderer-initiated outbound HTTPS
    /// commands (cloud_api_*, auth_token_*, ai_*, embed_*, object_version_push,
    /// sandbox_* in CL) short-circuit with -32099 while this connection is
    /// active. Default-on for prod, off elsewhere; user can flip after save.
    pub airgap_mode: bool,
    /// L2.1 PSDPM (PL/SQL Developer Parity Mode): when true, only user-initiated
    /// SQL is allowed. AI tools (CL only), embed batches (CL only), and any
    /// non-user RPC origins are blocked. Defaults ON when env=prod or
    /// env=staging, OFF for env=dev / unspecified at save time.
    pub psdpm_mode: bool,
    /// L3.2 (Onda 3): per-connection auto-EXPLAIN mode.
    /// "manual" | "always" | "when_dml". Default per env at save time:
    /// dev / unspecified → "manual"; staging / prod → "when_dml". User can
    /// freely change in the connection settings — no hard-lock.
    pub auto_explain_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "authType")]
pub enum ConnectionMeta {
    #[serde(rename = "basic", rename_all = "camelCase")]
    Basic {
        id: String,
        name: String,
        host: String,
        port: u16,
        service_name: String,
        username: String,
        created_at: String,
        updated_at: String,
        #[serde(flatten)]
        safety: ConnectionSafety,
    },
    #[serde(rename = "wallet", rename_all = "camelCase")]
    Wallet {
        id: String,
        name: String,
        connect_alias: String,
        username: String,
        created_at: String,
        updated_at: String,
        #[serde(flatten)]
        safety: ConnectionSafety,
    },
}

impl TryFrom<ConnectionRow> for ConnectionMeta {
    type Error = ConnectionError;
    fn try_from(r: ConnectionRow) -> Result<Self, ConnectionError> {
        let safety = ConnectionSafety {
            env: r.env.clone(),
            read_only: r.read_only,
            statement_timeout_ms: r.statement_timeout_ms,
            warn_unsafe_dml: r.warn_unsafe_dml,
            auto_perf_analysis: r.auto_perf_analysis,
            airgap_mode: r.airgap_mode,
            psdpm_mode: r.psdpm_mode,
            auto_explain_mode: r.auto_explain_mode.clone(),
        };
        match r.auth_type {
            AuthType::Basic => Ok(ConnectionMeta::Basic {
                id: r.id,
                name: r.name,
                host: r
                    .host
                    .ok_or_else(|| ConnectionError::internal("basic row missing host"))?,
                port: r
                    .port
                    .ok_or_else(|| ConnectionError::internal("basic row missing port"))?,
                service_name: r
                    .service_name
                    .ok_or_else(|| ConnectionError::internal("basic row missing service_name"))?,
                username: r.username,
                created_at: r.created_at,
                updated_at: r.updated_at,
                safety,
            }),
            AuthType::Wallet => Ok(ConnectionMeta::Wallet {
                id: r.id,
                name: r.name,
                connect_alias: r
                    .connect_alias
                    .ok_or_else(|| ConnectionError::internal("wallet row missing connect_alias"))?,
                username: r.username,
                created_at: r.created_at,
                updated_at: r.updated_at,
                safety,
            }),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFull {
    pub meta: ConnectionMeta,
    pub password_set: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_password_set: Option<bool>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionSafetyInput {
    pub env: Option<String>,
    pub read_only: bool,
    pub statement_timeout_ms: Option<u32>,
    pub warn_unsafe_dml: bool,
    #[serde(default = "default_true")]
    pub auto_perf_analysis: bool,
    /// L1.2 (Sprint C). Optional — when not provided, the save path defaults
    /// to `true` for prod and `false` otherwise. When provided (e.g. user
    /// toggling explicitly in the form), persistence is the truth.
    #[serde(default)]
    pub airgap_mode: Option<bool>,
    /// L2.1 PSDPM mode override. When None, the save layer chooses a default
    /// based on `env`: prod / staging → true, dev / unspecified → false.
    /// Existing UIs that don't send this field get the env-derived default.
    #[serde(default)]
    pub psdpm_mode: Option<bool>,
    /// L3.2 (Onda 3) auto-EXPLAIN mode override. When None, save layer
    /// chooses based on env (dev → "manual", staging/prod → "when_dml").
    /// Existing UIs that don't send this field get the env-derived default.
    #[serde(default)]
    pub auto_explain_mode: Option<String>,
}

/// Default policy for the L2.1 PSDPM toggle when the renderer omits the
/// explicit value: ON for env=prod / env=staging, OFF otherwise. Centralised
/// here so the rule lives in one place across CE / CL.
pub(crate) fn default_psdpm_for_env(env: Option<&str>) -> bool {
    matches!(env, Some("prod") | Some("staging"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "authType")]
pub enum ConnectionInput {
    #[serde(rename = "basic", rename_all = "camelCase")]
    Basic {
        id: Option<String>,
        name: String,
        host: String,
        port: u16,
        service_name: String,
        username: String,
        password: String,
        #[serde(default)]
        safety: ConnectionSafetyInput,
    },
    #[serde(rename = "wallet", rename_all = "camelCase")]
    Wallet {
        id: Option<String>,
        name: String,
        wallet_zip_path: Option<String>,
        wallet_password: String,
        connect_alias: String,
        username: String,
        password: String,
        #[serde(default)]
        safety: ConnectionSafetyInput,
    },
}

/// L1.2 (Sprint C): resolve the persisted `airgap_mode` value.
///
/// Hard-lock policy when env=prod: airgap_mode is FORCED true regardless of
/// explicit user override. The 4-layer enforcement is documented in
/// `docs/superpowers/specs/2026-05-06-sprint-c-geraldo-trust-edition.md`.
/// Layer 2 (this function) refuses to persist airgap_mode=false on a prod
/// connection. To enable AI on a prod connection, the user must DELETE and
/// recreate the connection with a non-prod env (F2 immutability rule).
///
/// When env != prod and explicit is provided, persistence honors it.
/// When explicit is None, default to true iff env is prod.
fn resolve_airgap_default(env: &Option<String>, explicit: Option<bool>) -> bool {
    if matches!(env.as_deref(), Some("prod")) {
        return true;
    }
    if let Some(v) = explicit {
        return v;
    }
    false
}

/// L2.1 (Sprint C) hard-lock: psdpm_mode is FORCED true on env=prod regardless
/// of explicit override. Same rationale as `resolve_airgap_default`.
pub(crate) fn resolve_psdpm_default(env: Option<&str>, explicit: Option<bool>) -> bool {
    if matches!(env, Some("prod")) {
        return true;
    }
    explicit.unwrap_or_else(|| default_psdpm_for_env(env))
}

/// L3.2 (Onda 3) policy for auto-EXPLAIN: dev / unspecified → "manual",
/// staging / prod → "when_dml". When the renderer sends an explicit
/// non-empty value, that wins. NOT a hard-lock: prod users can opt out.
pub(crate) fn resolve_auto_explain_default(env: Option<&str>, explicit: Option<&str>) -> String {
    if let Some(v) = explicit
        && !v.is_empty()
        && matches!(v, "manual" | "always" | "when_dml")
    {
        return v.to_string();
    }
    match env {
        Some("staging") | Some("prod") => "when_dml".to_string(),
        _ => "manual".to_string(),
    }
}

fn validate_env(env: &Option<String>) -> Result<(), ConnectionError> {
    if let Some(e) = env
        && !matches!(e.as_str(), "dev" | "staging" | "prod")
    {
        return Err(ConnectionError::invalid(
            "env must be 'dev', 'staging', or 'prod'",
        ));
    }
    Ok(())
}

// HIGH-002 (audit 2026-04-30): reject any character that has meaning in Oracle
// EZConnect+ syntax. Without this, a user-supplied host like
// `db.evil.com)(SECURITY=(SSL_SERVER_CERT_DN=*))` would be interpolated into
// the connection string and Oracle would parse it as TNS descriptor fragments,
// allowing connection-string injection (disable cert validation, redirect
// wallet location to attacker SMB share, etc.).
//
// Allowed: ASCII letters, digits, dot, hyphen, colon (IPv6), brackets (IPv6
// bracketed form). Reject anything else, including parentheses, equals, slash,
// backslash, question mark, ampersand, whitespace, control chars.
pub(crate) fn validate_host(host: &str) -> Result<(), ConnectionError> {
    if host.trim().is_empty() {
        return Err(ConnectionError::invalid("host is required"));
    }
    if host.len() > 253 {
        return Err(ConnectionError::invalid("host too long (max 253 chars)"));
    }
    let invalid_chars = [
        '(', ')', '?', '=', '/', '\\', ' ', '\t', '\n', '"', '\'', '@', '&', '%',
    ];
    if host
        .chars()
        .any(|c| invalid_chars.contains(&c) || c.is_control())
    {
        return Err(ConnectionError::invalid(
            "host contains invalid characters (allowed: letters, digits, hyphens, dots, colons, brackets for IPv6)",
        ));
    }
    Ok(())
}

pub(crate) fn validate_service_name(svc: &str) -> Result<(), ConnectionError> {
    if svc.trim().is_empty() {
        return Err(ConnectionError::invalid("service name is required"));
    }
    if svc.len() > 128 {
        return Err(ConnectionError::invalid(
            "service name too long (max 128 chars)",
        ));
    }
    if !svc
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(ConnectionError::invalid(
            "service name contains invalid characters (allowed: letters, digits, underscore, dot, hyphen)",
        ));
    }
    Ok(())
}

pub(crate) fn validate_connect_alias(alias: &str) -> Result<(), ConnectionError> {
    if alias.trim().is_empty() {
        return Err(ConnectionError::invalid("connect alias is required"));
    }
    if alias.len() > 128 {
        return Err(ConnectionError::invalid(
            "connect alias too long (max 128 chars)",
        ));
    }
    if !alias
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(ConnectionError::invalid(
            "connect alias contains invalid characters (allowed: letters, digits, underscore, dot, hyphen)",
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInfo {
    pub aliases: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionError {
    pub code: i32,
    pub message: String,
}

impl ConnectionError {
    fn not_found() -> Self {
        Self {
            code: 404,
            message: "connection not found".into(),
        }
    }
    fn conflict(msg: impl Into<String>) -> Self {
        Self {
            code: 409,
            message: msg.into(),
        }
    }
    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        Self {
            code: 400,
            message: msg.into(),
        }
    }
    pub(crate) fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: 500,
            message: msg.into(),
        }
    }
}

impl From<StoreError> for ConnectionError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => ConnectionError::not_found(),
            StoreError::Conflict(m) => ConnectionError::conflict(m),
            StoreError::Sqlite(e) => ConnectionError::internal(format!("sqlite: {e}")),
        }
    }
}

impl From<keyring::Error> for ConnectionError {
    fn from(e: keyring::Error) -> Self {
        ConnectionError::internal(format!("keyring: {e}"))
    }
}

impl From<wallet::WalletError> for ConnectionError {
    fn from(e: wallet::WalletError) -> Self {
        match e {
            wallet::WalletError::MissingFile(name) => {
                ConnectionError::invalid(format!("wallet missing required file: {name}"))
            }
            other => ConnectionError::invalid(format!("wallet: {other}")),
        }
    }
}

pub struct ConnectionService {
    conn: Mutex<SqliteConnection>,
    wallets_root: PathBuf,
    data_dir: PathBuf,
}

impl ConnectionService {
    pub fn open(db_path: &Path, wallets_root: PathBuf) -> Result<Self, ConnectionError> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| ConnectionError::internal(format!("mkdir {dir:?}: {e}")))?;
        }
        std::fs::create_dir_all(&wallets_root)
            .map_err(|e| ConnectionError::internal(format!("mkdir {wallets_root:?}: {e}")))?;
        // L1.4 (Sprint C, Onda 1.B) — encryption-at-rest for veesker.db.
        // The first time the user runs a build that has SQLCipher linked,
        // any pre-existing plaintext DB at this path is migrated in place
        // to an encrypted copy keyed off the OS keychain. Once migrated,
        // every subsequent open requires the keychain key — laptop theft
        // alone no longer leaks the connection metadata.
        let conn = open_encrypted_or_migrate(db_path)?;
        store::init_db(&conn)?;
        history::init_db_history(&conn).map_err(|e| match e {
            history::HistoryError::Sqlite(s) => ConnectionError::from(StoreError::from(s)),
            history::HistoryError::InvalidArg(m) => ConnectionError::internal(m),
        })?;
        object_versions::init_db_object_versions(&conn)
            .map_err(|e| ConnectionError::internal(format!("object_versions init: {e}")))?;
        let data_dir = db_path.parent().unwrap_or(Path::new(".")).to_path_buf();
        Ok(Self {
            conn: Mutex::new(conn),
            wallets_root,
            data_dir,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, SqliteConnection>, ConnectionError> {
        self.conn
            .lock()
            .map_err(|_| ConnectionError::internal("db mutex poisoned"))
    }

    fn wallet_dir(&self, id: &str) -> PathBuf {
        self.wallets_root.join(id)
    }

    pub fn list(&self) -> Result<Vec<ConnectionMeta>, ConnectionError> {
        let conn = self.lock()?;
        let rows = store::list(&conn)?;
        rows.into_iter().map(ConnectionMeta::try_from).collect()
    }

    pub fn get(&self, id: &str) -> Result<ConnectionFull, ConnectionError> {
        let row = {
            let conn = self.lock()?;
            store::get(&conn, id)?.ok_or_else(ConnectionError::not_found)?
        };
        let row_id = row.id.clone();
        let auth = row.auth_type.clone();
        let meta = ConnectionMeta::try_from(row)?;

        let password_set = match secrets::get_password(&row_id) {
            Ok(_) => true,
            Err(e) if secrets::is_missing(&e) => false,
            Err(e) => return Err(e.into()),
        };

        let wallet_password_set = match auth {
            AuthType::Basic => None,
            AuthType::Wallet => Some(match secrets::get_wallet_password(&row_id) {
                Ok(_) => true,
                Err(e) if secrets::is_missing(&e) => false,
                Err(e) => return Err(e.into()),
            }),
        };

        Ok(ConnectionFull {
            meta,
            password_set,
            wallet_password_set,
        })
    }

    /// Build the sidecar JSON-RPC params for opening an Oracle session
    /// for the saved connection identified by `id`. Reads passwords directly
    /// from the OS keychain — they are never stored in `ConnectionFull`.
    pub fn sidecar_params(&self, id: &str) -> Result<serde_json::Value, ConnectionError> {
        use super::connection_config::{basic_params_with_safety, wallet_params_with_safety};
        let row = {
            let conn = self.lock()?;
            store::get(&conn, id)?.ok_or_else(ConnectionError::not_found)?
        };
        let row_id = row.id.clone();
        let auth = row.auth_type.clone();
        let meta = ConnectionMeta::try_from(row)?;

        let password = match secrets::get_password(&row_id) {
            Ok(p) => p,
            Err(e) if secrets::is_missing(&e) => {
                return Err(ConnectionError::invalid(
                    "user password missing from keychain — edit the connection and re-enter the password",
                ));
            }
            Err(e) => return Err(e.into()),
        };

        match meta {
            ConnectionMeta::Basic {
                host,
                port,
                service_name,
                username,
                safety,
                ..
            } => Ok(basic_params_with_safety(
                &host,
                port,
                &service_name,
                &username,
                &password,
                &safety,
            )),
            ConnectionMeta::Wallet {
                connect_alias,
                username,
                id: meta_id,
                safety,
                ..
            } => {
                let wallet_password = match secrets::get_wallet_password(&row_id) {
                    Ok(p) => p,
                    Err(e) if secrets::is_missing(&e) => {
                        return Err(ConnectionError::invalid(
                            "wallet password missing from keychain — edit the connection and re-enter the wallet password",
                        ));
                    }
                    Err(e) => return Err(e.into()),
                };
                let _ = auth;
                let dir = self.wallet_dir(&meta_id);
                Ok(wallet_params_with_safety(
                    &dir,
                    &wallet_password,
                    &connect_alias,
                    &username,
                    &password,
                    &safety,
                ))
            }
        }
    }

    pub fn save(&self, input: ConnectionInput) -> Result<ConnectionMeta, ConnectionError> {
        let now = Utc::now().to_rfc3339();
        match input {
            ConnectionInput::Basic {
                id,
                name,
                host,
                port,
                service_name,
                username,
                password,
                safety,
            } => {
                if name.trim().is_empty() {
                    return Err(ConnectionError::invalid("name is required"));
                }
                // HIGH-002 (audit 2026-04-30): char-class validation prevents
                // EZConnect+ injection via host or service_name fields.
                validate_host(&host)?;
                validate_service_name(&service_name)?;
                if username.trim().is_empty() {
                    return Err(ConnectionError::invalid("username is required"));
                }
                if password.is_empty() && id.is_none() {
                    return Err(ConnectionError::invalid("password is required"));
                }
                validate_env(&safety.env)?;
                let row = self.assemble_basic_row(
                    id.as_deref(),
                    name,
                    host,
                    port,
                    service_name,
                    username,
                    &now,
                    safety,
                )?;
                self.persist_row(&row, id.is_some())?;
                if !password.is_empty() {
                    secrets::set_password(&row.id, &password)?;
                }
                ConnectionMeta::try_from(row)
            }
            ConnectionInput::Wallet {
                id,
                name,
                wallet_zip_path,
                wallet_password,
                connect_alias,
                username,
                password,
                safety,
            } => {
                if name.trim().is_empty() {
                    return Err(ConnectionError::invalid("name is required"));
                }
                if username.trim().is_empty() {
                    return Err(ConnectionError::invalid("username is required"));
                }
                if password.is_empty() && id.is_none() {
                    return Err(ConnectionError::invalid("password is required"));
                }
                if wallet_password.is_empty() && id.is_none() {
                    return Err(ConnectionError::invalid("wallet password is required"));
                }
                // HIGH-002 (audit 2026-04-30): char-class validation on the
                // wallet alias prevents the same injection vector via TNS aliases.
                validate_connect_alias(&connect_alias)?;
                validate_env(&safety.env)?;
                let row = self.assemble_wallet_row(
                    id.as_deref(),
                    name,
                    connect_alias.clone(),
                    username,
                    &now,
                    safety,
                )?;

                let wallet_dir = self.wallet_dir(&row.id);
                if let Some(zip_path) = wallet_zip_path.as_deref() {
                    let zip = Path::new(zip_path);
                    let body = wallet::read_tnsnames_from_zip(zip)?;
                    let aliases = tnsnames::parse_aliases(&body);
                    if !aliases
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(&connect_alias))
                    {
                        return Err(ConnectionError::invalid(format!(
                            "alias '{connect_alias}' not found in wallet's tnsnames.ora"
                        )));
                    }
                    wallet::extract_to(zip, &wallet_dir)?;
                } else {
                    if id.is_none() {
                        return Err(ConnectionError::invalid(
                            "wallet zip is required for new wallet connections",
                        ));
                    }
                    if !wallet_dir.exists() {
                        return Err(ConnectionError::invalid(
                            "wallet directory missing — please re-upload the wallet zip",
                        ));
                    }
                    let body = std::fs::read_to_string(wallet_dir.join("tnsnames.ora"))
                        .map_err(|e| ConnectionError::invalid(format!("read tnsnames.ora: {e}")))?;
                    let aliases = tnsnames::parse_aliases(&body);
                    if !aliases
                        .iter()
                        .any(|a| a.eq_ignore_ascii_case(&connect_alias))
                    {
                        return Err(ConnectionError::invalid(format!(
                            "alias '{connect_alias}' not found in saved tnsnames.ora"
                        )));
                    }
                }

                self.persist_row(&row, id.is_some())?;
                if !password.is_empty() {
                    secrets::set_password(&row.id, &password)?;
                }
                if !wallet_password.is_empty() {
                    secrets::set_wallet_password(&row.id, &wallet_password)?;
                }
                ConnectionMeta::try_from(row)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble_basic_row(
        &self,
        id: Option<&str>,
        name: String,
        host: String,
        port: u16,
        service_name: String,
        username: String,
        now: &str,
        safety: ConnectionSafetyInput,
    ) -> Result<ConnectionRow, ConnectionError> {
        // Sprint C 4-layer hard-lock: env=prod forces airgap_mode AND psdpm_mode
        // both ON regardless of explicit user override.
        let airgap_mode = resolve_airgap_default(&safety.env, safety.airgap_mode);
        let psdpm_mode = resolve_psdpm_default(safety.env.as_deref(), safety.psdpm_mode);
        let auto_explain_mode = resolve_auto_explain_default(
            safety.env.as_deref(),
            safety.auto_explain_mode.as_deref(),
        );
        match id {
            None => Ok(ConnectionRow {
                id: Uuid::new_v4().to_string(),
                name,
                auth_type: AuthType::Basic,
                host: Some(host),
                port: Some(port),
                service_name: Some(service_name),
                connect_alias: None,
                username,
                created_at: now.into(),
                updated_at: now.into(),
                env: safety.env,
                read_only: safety.read_only,
                statement_timeout_ms: safety.statement_timeout_ms,
                warn_unsafe_dml: safety.warn_unsafe_dml,
                auto_perf_analysis: safety.auto_perf_analysis,
                airgap_mode,
                psdpm_mode,
                auto_explain_mode,
            }),
            Some(id) => {
                let existing = {
                    let conn = self.lock()?;
                    store::get(&conn, id)?.ok_or_else(ConnectionError::not_found)?
                };
                if existing.auth_type != AuthType::Basic {
                    return Err(ConnectionError::invalid(
                        "cannot change auth type — delete and recreate the connection",
                    ));
                }
                // F2 (Sprint C): env is immutable after save. To change env,
                // delete and recreate the connection. Defense against trivial
                // env-override that would bypass the prod hard-lock.
                if existing.env != safety.env {
                    return Err(ConnectionError::invalid(
                        "env is immutable after save — delete and recreate the connection to change env",
                    ));
                }
                Ok(ConnectionRow {
                    id: existing.id,
                    name,
                    auth_type: AuthType::Basic,
                    host: Some(host),
                    port: Some(port),
                    service_name: Some(service_name),
                    connect_alias: None,
                    username,
                    created_at: existing.created_at,
                    updated_at: now.into(),
                    env: safety.env,
                    read_only: safety.read_only,
                    statement_timeout_ms: safety.statement_timeout_ms,
                    warn_unsafe_dml: safety.warn_unsafe_dml,
                    auto_perf_analysis: safety.auto_perf_analysis,
                    airgap_mode,
                    psdpm_mode,
                    auto_explain_mode,
                })
            }
        }
    }

    fn assemble_wallet_row(
        &self,
        id: Option<&str>,
        name: String,
        connect_alias: String,
        username: String,
        now: &str,
        safety: ConnectionSafetyInput,
    ) -> Result<ConnectionRow, ConnectionError> {
        // Sprint C 4-layer hard-lock: env=prod forces airgap_mode AND psdpm_mode
        // both ON regardless of explicit user override.
        let airgap_mode = resolve_airgap_default(&safety.env, safety.airgap_mode);
        let psdpm_mode = resolve_psdpm_default(safety.env.as_deref(), safety.psdpm_mode);
        let auto_explain_mode = resolve_auto_explain_default(
            safety.env.as_deref(),
            safety.auto_explain_mode.as_deref(),
        );
        match id {
            None => Ok(ConnectionRow {
                id: Uuid::new_v4().to_string(),
                name,
                auth_type: AuthType::Wallet,
                host: None,
                port: None,
                service_name: None,
                connect_alias: Some(connect_alias),
                username,
                created_at: now.into(),
                updated_at: now.into(),
                env: safety.env,
                read_only: safety.read_only,
                statement_timeout_ms: safety.statement_timeout_ms,
                warn_unsafe_dml: safety.warn_unsafe_dml,
                auto_perf_analysis: safety.auto_perf_analysis,
                airgap_mode,
                psdpm_mode,
                auto_explain_mode,
            }),
            Some(id) => {
                let existing = {
                    let conn = self.lock()?;
                    store::get(&conn, id)?.ok_or_else(ConnectionError::not_found)?
                };
                if existing.auth_type != AuthType::Wallet {
                    return Err(ConnectionError::invalid(
                        "cannot change auth type — delete and recreate the connection",
                    ));
                }
                // F2 (Sprint C): env is immutable after save.
                if existing.env != safety.env {
                    return Err(ConnectionError::invalid(
                        "env is immutable after save — delete and recreate the connection to change env",
                    ));
                }
                Ok(ConnectionRow {
                    id: existing.id,
                    name,
                    auth_type: AuthType::Wallet,
                    host: None,
                    port: None,
                    service_name: None,
                    connect_alias: Some(connect_alias),
                    username,
                    created_at: existing.created_at,
                    updated_at: now.into(),
                    env: safety.env,
                    read_only: safety.read_only,
                    statement_timeout_ms: safety.statement_timeout_ms,
                    warn_unsafe_dml: safety.warn_unsafe_dml,
                    auto_perf_analysis: safety.auto_perf_analysis,
                    airgap_mode,
                    psdpm_mode,
                    auto_explain_mode,
                })
            }
        }
    }

    fn persist_row(&self, row: &ConnectionRow, is_update: bool) -> Result<(), ConnectionError> {
        let conn = self.lock()?;
        if is_update {
            store::update(&conn, row)?;
        } else {
            store::create(&conn, row)?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), ConnectionError> {
        let row = {
            let conn = self.lock()?;
            store::get(&conn, id)?
        };
        {
            let conn = self.lock()?;
            store::delete(&conn, id)?;
        }
        // LOW-001 (audit 2026-04-30): use println! (not eprintln!) so the log
        // is captured by Tauri's stdout pipe consistently. Redact wallet path
        // to filename only — no full filesystem path leak via logs.
        if let Err(e) = secrets::delete_password(id) {
            println!("[connections] keychain delete failed for {id}: {e}");
        }
        if let Some(r) = row
            && r.auth_type == AuthType::Wallet
        {
            if let Err(e) = secrets::delete_wallet_password(id) {
                println!("[connections] wallet keychain delete failed for {id}: {e}");
            }
            let dir = self.wallet_dir(id);
            if dir.exists()
                && let Err(e) = std::fs::remove_dir_all(&dir)
            {
                let dir_name = dir
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "<unknown>".into());
                println!("[connections] wallet dir delete failed for {dir_name}: {e}");
            }
        }
        Ok(())
    }

    pub fn history_save(&self, input: history::HistorySaveInput) -> Result<i64, ConnectionError> {
        let conn = self.lock()?;
        history::insert(&conn, &input).map_err(|e| match e {
            history::HistoryError::Sqlite(s) => ConnectionError::from(StoreError::from(s)),
            history::HistoryError::InvalidArg(m) => ConnectionError::invalid(m),
        })
    }

    pub fn history_list(
        &self,
        connection_id: &str,
        limit: i64,
        offset: i64,
        search: Option<&str>,
    ) -> Result<Vec<history::HistoryEntry>, ConnectionError> {
        let conn = self.lock()?;
        history::list(&conn, connection_id, limit, offset, search).map_err(|e| match e {
            history::HistoryError::Sqlite(s) => ConnectionError::from(StoreError::from(s)),
            history::HistoryError::InvalidArg(m) => ConnectionError::invalid(m),
        })
    }

    pub fn history_clear(&self, connection_id: &str) -> Result<usize, ConnectionError> {
        let conn = self.lock()?;
        history::clear(&conn, connection_id).map_err(|e| match e {
            history::HistoryError::Sqlite(s) => ConnectionError::from(StoreError::from(s)),
            history::HistoryError::InvalidArg(m) => ConnectionError::invalid(m),
        })
    }

    pub fn inspect_wallet(&self, zip_path: &str) -> Result<WalletInfo, ConnectionError> {
        let body = wallet::read_tnsnames_from_zip(Path::new(zip_path))?;
        Ok(WalletInfo {
            aliases: tnsnames::parse_aliases(&body),
        })
    }

    pub fn object_version_capture(
        &self,
        connection_id: &str,
        owner: &str,
        object_type: &str,
        object_name: &str,
        ddl: &str,
        reason: &str,
    ) -> bool {
        let conn = match self.lock() {
            Ok(c) => c,
            Err(_) => return false,
        };
        object_versions::capture(
            &conn,
            &self.data_dir,
            connection_id,
            owner,
            object_type,
            object_name,
            ddl,
            reason,
        )
        .unwrap_or(false)
    }

    pub fn object_version_list(
        &self,
        connection_id: &str,
        owner: &str,
        object_type: &str,
        object_name: &str,
    ) -> Result<Vec<object_versions::ObjectVersionEntry>, ConnectionError> {
        let conn = self.lock()?;
        object_versions::list_versions(&conn, connection_id, owner, object_type, object_name)
            .map_err(|e| ConnectionError::internal(format!("object_version_list: {e}")))
    }

    pub fn object_version_diff(
        &self,
        connection_id: &str,
        sha_a: &str,
        sha_b: &str,
        file_path: &str,
    ) -> Result<String, ConnectionError> {
        object_versions::diff_commits(&self.data_dir, connection_id, sha_a, sha_b, file_path)
            .map_err(|e| ConnectionError::internal(format!("object_version_diff: {e}")))
    }

    pub fn object_version_load(
        &self,
        connection_id: &str,
        commit_sha: &str,
        file_path: &str,
    ) -> Result<String, ConnectionError> {
        object_versions::load_at_commit(&self.data_dir, connection_id, commit_sha, file_path)
            .map_err(|e| ConnectionError::internal(format!("object_version_load: {e}")))
    }

    pub fn object_version_set_label(
        &self,
        connection_id: &str,
        version_id: i64,
        owner: &str,
        object_type: &str,
        object_name: &str,
        label: Option<&str>,
    ) -> Result<(), ConnectionError> {
        let conn = self.lock()?;
        object_versions::set_label(
            &conn,
            &self.data_dir,
            connection_id,
            version_id,
            owner,
            object_type,
            object_name,
            label,
        )
        .map_err(|e| ConnectionError::internal(format!("object_version_set_label: {e}")))
    }

    pub fn object_version_set_remote(
        &self,
        connection_id: &str,
        remote_url: &str,
        pat: &str,
    ) -> Result<(), ConnectionError> {
        object_versions::set_remote(&self.data_dir, connection_id, remote_url, pat)
            .map_err(|e| ConnectionError::internal(format!("object_version_set_remote: {e}")))
    }

    pub fn object_version_get_remote(
        &self,
        connection_id: &str,
    ) -> Result<Option<String>, ConnectionError> {
        object_versions::get_remote(&self.data_dir, connection_id)
            .map_err(|e| ConnectionError::internal(format!("object_version_get_remote: {e}")))
    }

    pub fn object_version_push(&self, connection_id: &str) -> Result<u32, ConnectionError> {
        object_versions::push(&self.data_dir, connection_id)
            .map_err(|e| ConnectionError::internal(format!("object_version_push: {e}")))
    }
}

// L1.4 (Sprint C, Onda 1.B) — encryption-at-rest helpers.
//
// Migration policy: a fresh install gets an SQLCipher-encrypted DB from
// the start. An upgrade from an older Veesker (plaintext SQLite) detects
// the plaintext file on first start, copies the contents into a new
// encrypted DB via `sqlcipher_export`, renames the old file aside as
// `<stem>.legacy.<ts>.db`, and swaps the new encrypted file into place.
// The legacy backup is left for the user to delete after they verify the
// app still works — we do not auto-delete it.
fn open_encrypted_or_migrate(db_path: &Path) -> Result<SqliteConnection, ConnectionError> {
    let key = crate::crypto::get_or_create_db_key();
    let pragma_arg = crate::crypto::db_key_as_sqlcipher_pragma_arg(&key);

    if !db_path.exists() {
        return open_with_pragma_key(db_path, &pragma_arg);
    }

    if is_plaintext_sqlite(db_path)? {
        eprintln!(
            "veesker: detected plaintext veesker.db at {} — migrating to SQLCipher",
            db_path.display()
        );
        migrate_plaintext_to_encrypted(db_path, &pragma_arg)?;
    }

    open_with_pragma_key(db_path, &pragma_arg)
}

fn open_with_pragma_key(
    db_path: &Path,
    pragma_arg: &str,
) -> Result<SqliteConnection, ConnectionError> {
    let conn = SqliteConnection::open(db_path)
        .map_err(|e| ConnectionError::internal(format!("open {db_path:?}: {e}")))?;
    conn.execute_batch(&format!("PRAGMA key = {pragma_arg};"))
        .map_err(|e| ConnectionError::internal(format!("set sqlcipher key: {e}")))?;
    // Verify the key by forcing SQLCipher to decrypt the header. Wrong key
    // surfaces here as "file is encrypted or is not a database".
    conn.query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
        .map_err(|e| {
            ConnectionError::internal(format!(
                "verify sqlcipher key (wrong key or corrupted db): {e}"
            ))
        })?;
    Ok(conn)
}

fn is_plaintext_sqlite(db_path: &Path) -> Result<bool, ConnectionError> {
    // Open without a PRAGMA key. A plaintext SQLite header reads cleanly;
    // an SQLCipher-encrypted file errors on the first SQL operation.
    let conn = SqliteConnection::open(db_path)
        .map_err(|e| ConnectionError::internal(format!("probe open {db_path:?}: {e}")))?;
    Ok(conn
        .query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
        .is_ok())
}

fn migrate_plaintext_to_encrypted(db_path: &Path, pragma_arg: &str) -> Result<(), ConnectionError> {
    let parent = db_path.parent().unwrap_or(Path::new("."));
    let stem = db_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "veesker".to_string());
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let migrated_path = parent.join(format!("{stem}.migrated.{ts}.db"));
    let legacy_backup = parent.join(format!("{stem}.legacy.{ts}.db"));

    let plain = SqliteConnection::open(db_path)
        .map_err(|e| ConnectionError::internal(format!("plaintext open: {e}")))?;

    let migrated_path_str = migrated_path.to_string_lossy().replace('\'', "''");
    let attach_sql = format!(
        "ATTACH DATABASE '{migrated_path_str}' AS encrypted KEY {pragma_arg};\n\
         SELECT sqlcipher_export('encrypted');\n\
         DETACH DATABASE encrypted;"
    );
    if let Err(e) = plain.execute_batch(&attach_sql) {
        let _ = std::fs::remove_file(&migrated_path);
        return Err(ConnectionError::internal(format!(
            "sqlcipher_export migration: {e}"
        )));
    }
    drop(plain);

    if let Err(e) = std::fs::rename(db_path, &legacy_backup) {
        let _ = std::fs::remove_file(&migrated_path);
        return Err(ConnectionError::internal(format!(
            "rename plaintext to legacy backup: {e}"
        )));
    }
    if let Err(e) = std::fs::rename(&migrated_path, db_path) {
        // Best-effort restore so the user is not left with no DB at all.
        let _ = std::fs::rename(&legacy_backup, db_path);
        return Err(ConnectionError::internal(format!(
            "rename encrypted into place: {e}"
        )));
    }

    eprintln!(
        "veesker: encrypted veesker.db. Plaintext backup retained at {} — delete after verifying the app starts correctly.",
        legacy_backup.display()
    );
    Ok(())
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    // HIGH-002 (audit 2026-04-30): each Appendix C payload must be rejected.
    #[test]
    fn rejects_host_with_paren_injection() {
        assert!(validate_host("good.com)(SECURITY=").is_err());
    }

    #[test]
    fn rejects_host_with_question_mark() {
        assert!(validate_host("good.com?WALLET_LOCATION=//evil").is_err());
    }

    #[test]
    fn rejects_host_with_equals() {
        assert!(validate_host("good.com=evil.com").is_err());
    }

    #[test]
    fn rejects_host_with_whitespace() {
        assert!(validate_host("good com").is_err());
    }

    #[test]
    fn rejects_host_with_backslash() {
        assert!(validate_host("\\\\evil-server\\share").is_err());
    }

    #[test]
    fn rejects_host_with_zone_id() {
        assert!(validate_host("fe80::1%eth0").is_err());
    }

    #[test]
    fn accepts_valid_hostname() {
        assert!(validate_host("db.example.com").is_ok());
    }

    #[test]
    fn accepts_valid_ipv4() {
        assert!(validate_host("192.168.1.1").is_ok());
    }

    #[test]
    fn accepts_valid_ipv6_unbracketed() {
        assert!(validate_host("::1").is_ok());
    }

    #[test]
    fn accepts_valid_ipv6_bracketed() {
        assert!(validate_host("[2001:db8::1]").is_ok());
    }

    #[test]
    fn rejects_service_name_with_query_param() {
        assert!(validate_service_name("PROD?WALLET_LOCATION=//evil").is_err());
    }

    #[test]
    fn rejects_service_name_with_paren() {
        assert!(validate_service_name("PROD)(WRONG").is_err());
    }

    #[test]
    fn accepts_valid_service_name() {
        assert!(validate_service_name("FREEPDB1").is_ok());
        assert!(validate_service_name("orcl.example.com").is_ok());
    }

    #[test]
    fn rejects_service_name_too_long() {
        let long = "a".repeat(129);
        assert!(validate_service_name(&long).is_err());
    }

    #[test]
    fn rejects_connect_alias_with_special_chars() {
        assert!(validate_connect_alias("alias?param=value").is_err());
        assert!(validate_connect_alias("alias)injection").is_err());
    }

    #[test]
    fn accepts_valid_connect_alias() {
        assert!(validate_connect_alias("mydb_high").is_ok());
    }
}

#[cfg(test)]
mod encryption_tests {
    use super::*;
    use tempfile::TempDir;

    fn fixed_key_pragma() -> (Vec<u8>, String) {
        let key: Vec<u8> = (0u8..32u8).collect();
        let pragma = crate::crypto::db_key_as_sqlcipher_pragma_arg(&key);
        (key, pragma)
    }

    fn write_plaintext_db_with_one_row(path: &Path) {
        let conn = SqliteConnection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
             INSERT INTO t (id, payload) VALUES (1, 'survived migration');",
        )
        .unwrap();
        drop(conn);
    }

    #[test]
    fn is_plaintext_sqlite_detects_unencrypted() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("plain.db");
        write_plaintext_db_with_one_row(&db);
        assert!(is_plaintext_sqlite(&db).unwrap());
    }

    #[test]
    fn open_with_pragma_key_round_trips_on_fresh_encrypted_db() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("fresh.db");
        let (_, pragma) = fixed_key_pragma();
        let conn = open_with_pragma_key(&db, &pragma).unwrap();
        conn.execute_batch("CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('hi');")
            .unwrap();
        drop(conn);

        let conn2 = open_with_pragma_key(&db, &pragma).unwrap();
        let v: String = conn2
            .query_row("SELECT k FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "hi");
    }

    #[test]
    fn open_with_wrong_key_fails() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("encrypted.db");
        let (_, good) = fixed_key_pragma();
        {
            let conn = open_with_pragma_key(&db, &good).unwrap();
            conn.execute_batch("CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('hi');")
                .unwrap();
        }
        let bad_key: Vec<u8> = (32u8..64u8).collect();
        let bad_pragma = crate::crypto::db_key_as_sqlcipher_pragma_arg(&bad_key);
        assert!(open_with_pragma_key(&db, &bad_pragma).is_err());
    }

    #[test]
    fn migrate_plaintext_to_encrypted_preserves_data_and_creates_legacy_backup() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("veesker.db");
        write_plaintext_db_with_one_row(&db);
        let (_, pragma) = fixed_key_pragma();

        migrate_plaintext_to_encrypted(&db, &pragma).unwrap();

        // Reopened with the right key, the row is still there.
        let conn = open_with_pragma_key(&db, &pragma).unwrap();
        let payload: String = conn
            .query_row("SELECT payload FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(payload, "survived migration");

        // A `<stem>.legacy.<ts>.db` backup exists so the user can recover.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries
                .iter()
                .any(|n| n.starts_with("veesker.legacy.") && n.ends_with(".db")),
            "expected a *.legacy.*.db backup to be present, got: {entries:?}"
        );
    }

    #[test]
    fn open_encrypted_or_migrate_handles_fresh_install() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("veesker.db");
        let conn = open_encrypted_or_migrate(&db).unwrap();
        conn.execute_batch("CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('first run');")
            .unwrap();
        drop(conn);

        let conn2 = open_encrypted_or_migrate(&db).unwrap();
        let v: String = conn2
            .query_row("SELECT k FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "first run");
    }

    #[test]
    fn open_encrypted_or_migrate_migrates_legacy_plaintext_db() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("veesker.db");
        write_plaintext_db_with_one_row(&db);
        // Sanity: file is plaintext to start.
        assert!(is_plaintext_sqlite(&db).unwrap());

        let conn = open_encrypted_or_migrate(&db).unwrap();
        let payload: String = conn
            .query_row("SELECT payload FROM t WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(payload, "survived migration");
        drop(conn);

        // After migration, the file is no longer plaintext.
        assert!(!is_plaintext_sqlite(&db).unwrap());
    }
}
