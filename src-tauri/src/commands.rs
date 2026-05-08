// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

use crate::sidecar::acquire;
use crate::tray::{self, ActiveConnection, TrayState};

#[derive(Debug, Deserialize)]
#[serde(tag = "authType")]
pub enum ConnectionConfig {
    #[serde(rename = "basic", rename_all = "camelCase")]
    Basic {
        host: String,
        port: u16,
        service_name: String,
        username: String,
        password: String,
    },
    #[serde(rename = "wallet", rename_all = "camelCase")]
    Wallet {
        wallet_dir: String,
        wallet_password: String,
        connect_alias: String,
        username: String,
        password: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestOk {
    pub server_version: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestErr {
    pub code: i32,
    pub message: String,
}

// MEDIUM-002 (audit 2026-04-30): validate the wallet directory path BEFORE
// passing it to the sidecar. Without this, connection_test would accept a UNC
// path like \\evil-server\share which would leak NTLM hashes on Windows when
// oracledb opens the wallet location.
//
// HIGH-002 also re-validates host/serviceName/connect_alias as belt-and-
// suspenders even though connection_save already does so via persistence layer.
fn config_to_params(app: &AppHandle, config: ConnectionConfig) -> Result<Value, ConnectionError> {
    use crate::persistence::connection_config::{basic_params, wallet_params};
    use crate::persistence::connections::{
        validate_connect_alias, validate_host, validate_service_name,
    };
    match config {
        ConnectionConfig::Basic {
            host,
            port,
            service_name,
            username,
            password,
        } => {
            validate_host(&host)?;
            validate_service_name(&service_name)?;
            Ok(basic_params(
                &host,
                port,
                &service_name,
                &username,
                &password,
            ))
        }
        ConnectionConfig::Wallet {
            wallet_dir,
            wallet_password,
            connect_alias,
            username,
            password,
        } => {
            let canon = validate_user_path(app, &wallet_dir)?;
            validate_connect_alias(&connect_alias)?;
            Ok(wallet_params(
                &canon,
                &wallet_password,
                &connect_alias,
                &username,
                &password,
            ))
        }
    }
}

#[tauri::command]
pub async fn connection_test(
    app: AppHandle,
    config: ConnectionConfig,
) -> Result<ConnectionTestOk, ConnectionTestErr> {
    let sidecar = acquire(&app).await.map_err(|err| ConnectionTestErr {
        code: -32003,
        message: err,
    })?;

    let params = config_to_params(&app, config).map_err(|err| ConnectionTestErr {
        code: err.code,
        message: err.message,
    })?;
    let result = sidecar
        .call("connection.test", params)
        .await
        .map_err(|err| ConnectionTestErr {
            code: err.code,
            message: err.message,
        })?;

    let server_version = result
        .get("serverVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("Oracle (unknown)")
        .to_string();
    let elapsed_ms = result
        .get("elapsedMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Ok(ConnectionTestOk {
        server_version,
        elapsed_ms,
    })
}

use crate::persistence::connections::{
    ConnectionError, ConnectionFull, ConnectionInput, ConnectionMeta, ConnectionService, WalletInfo,
};
use crate::persistence::history::{HistoryEntry, HistorySaveInput};

pub struct ActiveSessionEnv(pub tokio::sync::Mutex<Option<String>>);

/// L1.2 (Sprint C — Air-gap mode). When `true`, every Tauri command that makes
/// outbound HTTPS calls (cloud_api_*, auth_token_*, ai_*, embed_*,
/// object_version_push, object_version_get_remote) short-circuits with the
/// shared `-32099` JSON-RPC error. The state is loaded from
/// `connection.airgap_mode` on `workspace_open` and reset on `workspace_close`,
/// so toggling is per-connection and resets between sessions.
///
/// Note: `tauri-plugin-updater` runs its own check on app start. Air-gap mode
/// does NOT disable that startup check; it only gates renderer-initiated
/// network commands. True air-gap requires running the app with
/// `VEESKER_DISABLE_UPDATER=1` set; the env-var support is tracked separately.
/// This struct gates renderer-controllable egress only.
pub struct AirGapState(pub tokio::sync::Mutex<bool>);

/// Shared error message and code for every air-gap-blocked command. -32099 is
/// outside the standard JSON-RPC reserved range so the renderer can match it
/// reliably.
pub(crate) const AIRGAP_ERR_CODE: i32 = -32099;
pub(crate) const AIRGAP_ERR_MSG: &str =
    "Air-gap mode active: outbound network calls are disabled for this connection";

pub(crate) fn airgap_blocked_err() -> ConnectionTestErr {
    ConnectionTestErr {
        code: AIRGAP_ERR_CODE,
        message: AIRGAP_ERR_MSG.to_string(),
    }
}

pub(crate) fn airgap_blocked_string() -> String {
    format!("airgap_blocked: {AIRGAP_ERR_MSG}")
}

/// Read the current air-gap state. Awaits the lock briefly and returns the
/// inner bool — callers should use this at the top of every gated command.
async fn airgap_active(app: &AppHandle) -> bool {
    *app.state::<AirGapState>().0.lock().await
}

// L2.1 PSDPM (PL/SQL Developer Parity Mode) — per-session active flag mirrored
// from the saved connection. Workspace_open populates it from the connection
// row; workspace_close clears it. The sidecar enforces the gate on incoming
// non-user-initiated RPCs.
pub struct PsdpmState(pub tokio::sync::Mutex<bool>);

/// Returns the canonicalized path if `path` (as supplied by the renderer) resolves to a
/// location under one of the user-data scopes ($DOCUMENT, $DESKTOP, $DOWNLOAD, $HOME,
/// app data dir, app config dir). Anything else is rejected to prevent a compromised
/// renderer from feeding arbitrary system paths to a #[tauri::command] handler that
/// bypasses the renderer-side `fs:scope` capability allow-list.
fn validate_user_path(app: &AppHandle, path: &str) -> Result<PathBuf, ConnectionError> {
    let p = Path::new(path);
    let canon = p
        .canonicalize()
        .map_err(|_| ConnectionError::invalid("file not accessible"))?;
    let candidates = [
        app.path().document_dir().ok(),
        app.path().desktop_dir().ok(),
        app.path().download_dir().ok(),
        app.path().home_dir().ok(),
        app.path().app_data_dir().ok(),
        app.path().app_config_dir().ok(),
    ];
    for root in candidates.iter().flatten() {
        if let Ok(canon_root) = root.canonicalize()
            && canon.starts_with(&canon_root)
        {
            return Ok(canon);
        }
    }
    Err(ConnectionError::invalid(
        "path outside allowed user folders (Documents, Desktop, Downloads, Home)",
    ))
}

#[tauri::command]
pub async fn connection_list(app: AppHandle) -> Result<Vec<ConnectionMeta>, ConnectionError> {
    let svc = app.state::<ConnectionService>();
    svc.list()
}

#[tauri::command]
pub async fn connection_get(app: AppHandle, id: String) -> Result<ConnectionFull, ConnectionError> {
    let svc = app.state::<ConnectionService>();
    svc.get(&id)
}

#[tauri::command]
pub async fn connection_save(
    app: AppHandle,
    mut input: ConnectionInput,
) -> Result<ConnectionMeta, ConnectionError> {
    // If a wallet zip path is being supplied, validate it lives under an allowed
    // user folder before the persistence layer touches it.
    if let ConnectionInput::Wallet {
        wallet_zip_path: Some(ref mut path),
        ..
    } = input
    {
        let canon = validate_user_path(&app, path)?;
        *path = canon.to_string_lossy().into_owned();
    }
    let svc = app.state::<ConnectionService>();
    svc.save(input)
}

#[tauri::command]
pub async fn connection_delete(app: AppHandle, id: String) -> Result<(), ConnectionError> {
    let svc = app.state::<ConnectionService>();
    svc.delete(&id)
}

#[tauri::command]
pub async fn wallet_inspect(
    app: AppHandle,
    zip_path: String,
) -> Result<WalletInfo, ConnectionError> {
    let canon = validate_user_path(&app, &zip_path)?;
    let svc = app.state::<ConnectionService>();
    svc.inspect_wallet(&canon.to_string_lossy())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub server_version: String,
    pub current_schema: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaRow {
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub data_default: Option<String>,
    pub comments: Option<String>,
    #[serde(default)]
    pub is_vector: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub is_unique: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
    pub row_count: Option<i64>,
}

async fn call_sidecar(
    app: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, ConnectionTestErr> {
    // acquire() returns an Arc<Sidecar> after a brief lock. The lock is dropped
    // before we await the call, so concurrent RPCs (e.g. query.cancel arriving
    // while query.execute is in flight) don't serialize through us.
    let sidecar = acquire(app).await.map_err(|err| ConnectionTestErr {
        code: -32003,
        message: err,
    })?;
    sidecar
        .call(method, params)
        .await
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

fn map_err(e: ConnectionError) -> ConnectionTestErr {
    ConnectionTestErr {
        code: e.code,
        message: e.message,
    }
}

#[tauri::command]
pub async fn workspace_open(
    app: AppHandle,
    connection_id: String,
) -> Result<WorkspaceInfo, ConnectionTestErr> {
    let (params, conn_name, conn_env, conn_airgap, conn_psdpm) = {
        let svc = app.state::<ConnectionService>();
        let params = svc.sidecar_params(&connection_id).map_err(map_err)?;
        let full = svc.get(&connection_id).ok();
        let (name, env, airgap, psdpm) = full
            .map(|f| {
                use crate::persistence::connections::ConnectionMeta;
                match f.meta {
                    ConnectionMeta::Basic { name, safety, .. } => {
                        (name, safety.env, safety.airgap_mode, safety.psdpm_mode)
                    }
                    ConnectionMeta::Wallet { name, safety, .. } => {
                        (name, safety.env, safety.airgap_mode, safety.psdpm_mode)
                    }
                }
            })
            .unwrap_or_else(|| (connection_id.clone(), None, false, false));
        (params, name, env, airgap, psdpm)
    };

    tray::update_tray(&app, TrayState::Connecting).await;

    let res = match call_sidecar(&app, "workspace.open", params).await {
        Ok(v) => v,
        Err(e) => {
            tray::update_tray(&app, TrayState::Error).await;
            return Err(e);
        }
    };

    // 4-layer hard-lock Layer 3 (Sprint C): when env=prod, force airgap_mode
    // and psdpm_mode ON regardless of stored value. This catches the case
    // where the SQLite row was hand-edited or migrated from before the
    // hard-lock was wired.
    let env_is_prod = conn_env.as_deref() == Some("prod");
    let effective_airgap = env_is_prod || conn_airgap;
    let effective_psdpm = env_is_prod || conn_psdpm;
    *app.state::<ActiveConnection>().0.lock().await = Some(conn_name);
    *app.state::<ActiveSessionEnv>().0.lock().await = conn_env;
    // L1.2 (Sprint C): activate air-gap immediately after the Oracle session
    // opens. Outbound HTTPS commands now short-circuit until workspace_close.
    *app.state::<AirGapState>().0.lock().await = effective_airgap;
    // L2.1: mirror the connection's PSDPM flag to the per-session state so
    // status-bar / diagnostic queries can read it without re-loading the row.
    *app.state::<PsdpmState>().0.lock().await = effective_psdpm;
    tray::update_tray(&app, TrayState::Connected).await;

    let server_version = res
        .get("serverVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let current_schema = res
        .get("currentSchema")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(WorkspaceInfo {
        server_version,
        current_schema,
    })
}

/// L2.1: expose the active PSDPM flag so the StatusBar badge and diagnostic
/// surfaces can render the lock without re-loading the connection row.
#[tauri::command]
pub async fn psdpm_active(app: AppHandle) -> bool {
    *app.state::<PsdpmState>().0.lock().await
}

#[tauri::command]
pub async fn workspace_close(app: AppHandle) -> Result<(), ConnectionTestErr> {
    call_sidecar(&app, "workspace.close", json!({})).await?;
    *app.state::<ActiveConnection>().0.lock().await = None;
    *app.state::<ActiveSessionEnv>().0.lock().await = None;
    // L1.2 (Sprint C): clear air-gap when the workspace closes so the next
    // connection picks up its own setting.
    *app.state::<AirGapState>().0.lock().await = false;
    // L2.1: PSDPM flag is per-session — reset to off when the workspace closes.
    *app.state::<PsdpmState>().0.lock().await = false;
    tray::update_tray(&app, TrayState::Idle).await;
    Ok(())
}

#[tauri::command]
pub async fn schema_list(app: AppHandle) -> Result<Vec<SchemaRow>, ConnectionTestErr> {
    let res = call_sidecar(&app, "schema.list", json!({})).await?;
    let arr = res
        .get("schemas")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(arr
        .into_iter()
        .filter_map(|v| {
            Some(SchemaRow {
                name: v.get("name")?.as_str()?.to_string(),
                is_current: v.get("isCurrent")?.as_bool().unwrap_or(false),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn objects_list(
    app: AppHandle,
    owner: String,
    kind: String,
) -> Result<Vec<ObjectRef>, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "objects.list",
        json!({ "owner": owner, "type": kind }),
    )
    .await?;
    let arr = res
        .get("objects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(arr
        .into_iter()
        .filter_map(|v| {
            Some(ObjectRef {
                name: v.get("name")?.as_str()?.to_string(),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn table_describe(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<TableDetails, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "table.describe",
        json!({ "owner": owner, "name": name }),
    )
    .await?;
    serde_json::from_value(res).map_err(|e| ConnectionTestErr {
        code: -32099,
        message: format!("decode table.describe: {e}"),
    })
}

#[tauri::command]
pub async fn table_count_rows(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "table.count_rows",
        json!({ "owner": owner, "name": name }),
    )
    .await?;
    Ok(res)
}

#[tauri::command]
pub async fn table_related(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "table.related",
        json!({ "owner": owner, "name": name }),
    )
    .await?;
    Ok(res)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn query_execute(
    app: AppHandle,
    sql: String,
    request_id: String,
    split_multi: Option<bool>,
    fetch_all: Option<bool>,
    acknowledge_unsafe: Option<bool>,
    // L2.2 Origin attribution: tags the source of this SQL so the
    // Activity Ledger can color-code and filter by who/what initiated it.
    origin: Option<String>,
    origin_detail: Option<String>,
) -> Result<Value, ConnectionTestErr> {
    let started = std::time::Instant::now();
    let result = call_sidecar(
        &app,
        "query.execute",
        json!({
            "sql": sql,
            "requestId": request_id,
            "splitMulti": split_multi.unwrap_or(false),
            "fetchAll": fetch_all.unwrap_or(false),
            "acknowledgeUnsafe": acknowledge_unsafe.unwrap_or(false),
        }),
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis() as i64;

    // Authoritative audit write: happens here, server-side, regardless of whether
    // the renderer remembers to call history_save afterwards. A compromised renderer
    // can no longer skip audit just by not calling history_save.
    if let Ok(data_dir) = app.path().app_data_dir() {
        let active_name = app
            .state::<ActiveConnection>()
            .0
            .lock()
            .await
            .clone()
            .unwrap_or_default();
        let (conn_id, host, username) = lookup_active_connection_meta(&app, &active_name);
        let (success, error_message) = match &result {
            Ok(v) => {
                let multi_failed = v
                    .get("results")
                    .and_then(|rs| rs.as_array())
                    .map(|arr| {
                        arr.iter()
                            .any(|r| r.get("status").and_then(|s| s.as_str()) == Some("error"))
                    })
                    .unwrap_or(false);
                (!multi_failed, None)
            }
            Err(e) => (false, Some(e.message.clone())),
        };
        // L2.2: if the renderer didn't pass an origin, infer ai_approved from
        // the requestId convention ("ai:*"). Falls back to user_typed otherwise.
        let final_origin = origin.unwrap_or_else(|| {
            if request_id.starts_with("ai:") {
                "ai_approved".to_string()
            } else {
                "user_typed".to_string()
            }
        });
        let synthetic_input = HistorySaveInput {
            connection_id: conn_id,
            sql: sql.clone(),
            success,
            row_count: None,
            elapsed_ms,
            error_code: None,
            error_message,
            username: Some(username),
            host: Some(host),
            origin: Some(final_origin),
            origin_detail,
        };
        let source = if request_id.starts_with("ai:") {
            "ai"
        } else {
            "user"
        };
        let env_val = app.state::<ActiveSessionEnv>().0.lock().await.clone();
        let entry = write_audit_entry(&data_dir, &synthetic_input, source, env_val.as_deref());
        // L2.5 Activity Ledger: emit the just-written entry to the renderer for
        // real-time updates. Best-effort — emit failure does not affect the query.
        if let Some(ref e) = entry {
            let _ = app.emit("audit:append", e);
        }
    }

    result
}

/// Best-effort lookup of (connection_id, host, username) for the currently
/// active connection name. Returns empty strings if not found — the audit
/// row is still written with whatever metadata is known.
fn lookup_active_connection_meta(app: &AppHandle, active_name: &str) -> (String, String, String) {
    if active_name.is_empty() {
        return (String::new(), String::new(), String::new());
    }
    let svc = app.state::<ConnectionService>();
    let metas = match svc.list() {
        Ok(m) => m,
        Err(_) => return (String::new(), String::new(), String::new()),
    };
    use crate::persistence::connections::ConnectionMeta;
    for meta in metas {
        match meta {
            ConnectionMeta::Basic {
                id,
                name,
                host,
                username,
                ..
            } if name == active_name => {
                return (id, host, username);
            }
            ConnectionMeta::Wallet {
                id,
                name,
                connect_alias,
                username,
                ..
            } if name == active_name => {
                return (id, connect_alias, username);
            }
            _ => continue,
        }
    }
    (String::new(), String::new(), String::new())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCancelResult {
    pub cancelled: bool,
    pub request_id: Option<String>,
}

#[tauri::command]
pub async fn query_cancel(
    app: AppHandle,
    request_id: String,
) -> Result<QueryCancelResult, ConnectionTestErr> {
    let res = call_sidecar(&app, "query.cancel", json!({ "requestId": request_id })).await?;
    let cancelled = res
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let returned_id = res
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(QueryCancelResult {
        cancelled,
        request_id: returned_id,
    })
}

#[tauri::command]
pub async fn history_list(
    app: AppHandle,
    connection_id: String,
    limit: i64,
    offset: i64,
    search: Option<String>,
) -> Result<Vec<HistoryEntry>, ConnectionError> {
    let svc = app.state::<ConnectionService>();
    svc.history_list(&connection_id, limit, offset, search.as_deref())
}

// L2.5: returns the JSON entry that was just written so callers can emit it
// to the renderer (Activity Ledger). Returns None if the audit dir or file
// could not be created/opened — emit is then skipped.
fn write_audit_entry(
    app_data_dir: &std::path::Path,
    input: &HistorySaveInput,
    source: &str,
    env: Option<&str>,
) -> Option<Value> {
    let audit_dir = app_data_dir.join("audit");
    if std::fs::create_dir_all(&audit_dir).is_err() {
        return None;
    }
    let now = chrono::Utc::now();
    let date = now.format("%Y-%m-%d").to_string();
    let path = audit_dir.join(format!("{date}.jsonl"));
    let entry = serde_json::json!({
        "ts":           now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "connectionId": input.connection_id,
        "host":         input.host.as_deref().unwrap_or(""),
        "username":     input.username.as_deref().unwrap_or(""),
        "sql":          input.sql,
        "success":      input.success,
        "rowCount":     input.row_count,
        "elapsedMs":    input.elapsed_ms,
        "errorCode":    input.error_code,
        "errorMessage": input.error_message,
        "source":       source,
        "env":          env.unwrap_or(""),
        // L2.2 Origin attribution. Defaults to "user_typed" when missing so
        // legacy callers (history_save) still produce a valid origin for the
        // Activity Ledger filter UI.
        "origin":       input.origin.clone().unwrap_or_else(|| "user_typed".to_string()),
        "originDetail": input.origin_detail,
    });
    // L1.4 (Sprint C, Onda 1.B): envelope each line in AES-256-GCM. Legacy
    // plaintext lines (`{...}`) and encrypted lines (`02:<base64>`) coexist
    // in the same file — read paths detect by prefix. Rendering to the
    // Activity Ledger uses the plain entry, so the renderer never sees
    // ciphertext.
    let body = entry.to_string();
    let cipher_key = crate::crypto::get_or_create_audit_cipher_key();
    let line_payload = match crate::crypto::encrypt_audit_line(&cipher_key, &body) {
        Ok(s) => s,
        Err(_) => body.clone(),
    };
    let mut line = line_payload;
    line.push('\n');
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        if file.write_all(line.as_bytes()).is_err() {
            return None;
        }
    } else {
        return None;
    }
    Some(entry)
}

#[tauri::command]
pub async fn history_save(app: AppHandle, input: HistorySaveInput) -> Result<i64, ConnectionError> {
    if let Ok(data_dir) = app.path().app_data_dir() {
        // L2.5 Activity Ledger: emit the entry so the renderer panel updates
        // even when the SQL was logged through history_save (e.g. background
        // jobs that don't go through query_execute).
        let entry = write_audit_entry(&data_dir, &input, "user", None);
        if let Some(ref e) = entry {
            let _ = app.emit("audit:append", e);
        }
    }
    let svc = app.state::<ConnectionService>();
    svc.history_save(input)
}

// L2.5 Activity Ledger: read the last `limit` audit entries from today's
// JSONL log and return them in chronological-newest-first order. Used by the
// frontend on mount to populate the panel before live `audit:append` events
// take over. Lines that fail to parse as JSON are skipped silently.
#[tauri::command]
pub async fn audit_recent(app: AppHandle, limit: Option<i64>) -> Vec<Value> {
    let limit = limit.unwrap_or(200).clamp(1, 1000) as usize;
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let audit_dir = data_dir.join("audit");
    let now = chrono::Utc::now();
    let date = now.format("%Y-%m-%d").to_string();
    let path = audit_dir.join(format!("{date}.jsonl"));
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let text = match std::str::from_utf8(&bytes) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    // L1.4 (Sprint C, Onda 1.B): lines may be plaintext JSON (legacy) or
    // `02:<base64>` AES-GCM envelopes — decrypt envelopes using the audit
    // cipher key, then JSON-parse the result. Single corrupted records are
    // skipped silently so a single tampered byte doesn't black out the
    // whole panel.
    let cipher_key = crate::crypto::get_or_create_audit_cipher_key();
    let mut entries: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(
            |l| match crate::crypto::decrypt_audit_line_if_envelope(&cipher_key, l) {
                Ok(Some(plain)) => serde_json::from_str::<Value>(&plain).ok(),
                Ok(None) => serde_json::from_str::<Value>(l).ok(),
                Err(_) => None,
            },
        )
        .collect();
    // newest-first
    entries.reverse();
    entries.truncate(limit);
    entries
}

#[tauri::command]
pub async fn history_clear(
    app: AppHandle,
    connection_id: String,
) -> Result<usize, ConnectionError> {
    let svc = app.state::<ConnectionService>();
    svc.history_clear(&connection_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRefWithStatus {
    pub name: String,
    pub status: String,
}

#[tauri::command]
pub async fn objects_list_plsql(
    app: AppHandle,
    owner: String,
    kind: String,
) -> Result<Vec<ObjectRefWithStatus>, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "objects.list.plsql",
        json!({ "owner": owner, "kind": kind }),
    )
    .await?;
    let arr = res
        .get("objects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let objects = arr
        .into_iter()
        .filter_map(|v| {
            Some(ObjectRefWithStatus {
                name: v.get("name")?.as_str()?.to_string(),
                status: v.get("status")?.as_str()?.to_string(),
            })
        })
        .collect();
    Ok(objects)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileErrorRow {
    pub line: i64,
    pub position: i64,
    pub text: String,
}

#[tauri::command]
pub async fn compile_errors_get(
    app: AppHandle,
    object_type: String,
    object_name: String,
) -> Result<Vec<CompileErrorRow>, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "compile.errors",
        json!({ "objectType": object_type, "objectName": object_name }),
    )
    .await?;
    let arr = res
        .get("errors")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let errors = arr
        .into_iter()
        .filter_map(|v| {
            Some(CompileErrorRow {
                line: v.get("line")?.as_i64()?,
                position: v.get("position")?.as_i64()?,
                text: v.get("text")?.as_str()?.to_string(),
            })
        })
        .collect();
    Ok(errors)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDdlResult {
    pub ddl: String,
    pub spec: Option<String>,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn object_ddl_get(
    app: AppHandle,
    owner: String,
    object_type: String,
    object_name: String,
) -> Result<ObjectDdlResult, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "object.ddl",
        json!({ "owner": owner, "objectType": object_type, "objectName": object_name }),
    )
    .await?;
    let ddl = res
        .get("ddl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let spec = res
        .get("spec")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let body = res
        .get("body")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(ObjectDdlResult { ddl, spec, body })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFlowNode {
    pub owner: String,
    pub name: String,
    pub object_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFlowTriggerInfo {
    pub name: String,
    pub trigger_type: String,
    pub event: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFlowResult {
    pub upstream: Vec<DataFlowNode>,
    pub downstream: Vec<DataFlowNode>,
    pub fk_parents: Vec<DataFlowNode>,
    pub fk_children: Vec<DataFlowNode>,
    pub triggers: Vec<DataFlowTriggerInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultRow {
    pub owner: String,
    pub name: String,
    pub object_type: String,
}

#[tauri::command]
pub async fn objects_search(
    app: AppHandle,
    query: String,
) -> Result<Vec<SearchResultRow>, ConnectionTestErr> {
    let res = call_sidecar(&app, "objects.search", json!({ "query": query })).await?;
    let arr = res
        .get("objects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(arr
        .into_iter()
        .filter_map(|v| {
            Some(SearchResultRow {
                owner: v.get("owner")?.as_str()?.to_string(),
                name: v.get("name")?.as_str()?.to_string(),
                object_type: v.get("type")?.as_str()?.to_string(),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn schema_kind_counts(app: AppHandle, owner: String) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "schema.kind_counts", json!({ "owner": owner })).await?;
    Ok(res)
}

#[tauri::command]
pub async fn ai_chat(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_err());
    }
    let res = call_sidecar(&app, "ai.chat", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn ai_suggest_endpoint(
    app: AppHandle,
    params: Value,
) -> Result<Value, ConnectionTestErr> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_err());
    }
    let res = call_sidecar(&app, "ai.suggest_endpoint", params).await?;
    Ok(res)
}

#[tauri::command]
pub async fn vector_index_create(
    app: AppHandle,
    payload: Value,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "vector.create_index", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn vector_index_drop(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "vector.drop_index", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn embed_count_pending(
    app: AppHandle,
    payload: Value,
) -> Result<Value, ConnectionTestErr> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_err());
    }
    let res = call_sidecar(&app, "embed.count_pending", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn embed_batch(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_err());
    }
    let res = call_sidecar(&app, "embed.batch", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn ai_key_save(app: AppHandle, service: String, key: String) -> Result<(), String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    crate::persistence::secrets::set_api_key(&service, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_key_get(app: AppHandle, service: String) -> Result<Option<String>, String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    crate::persistence::secrets::get_api_key(&service).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connection_commit(app: AppHandle) -> Result<(), ConnectionTestErr> {
    call_sidecar(&app, "connection.commit", json!({})).await?;
    Ok(())
}

#[tauri::command]
pub async fn connection_rollback(app: AppHandle) -> Result<(), ConnectionTestErr> {
    call_sidecar(&app, "connection.rollback", json!({})).await?;
    Ok(())
}

#[tauri::command]
pub async fn connection_tx_state(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "connection.txState", json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn driver_mode(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "driver.mode", json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn vector_search(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "vector.search", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn vector_tables_in_schema(
    app: AppHandle,
    owner: String,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "vector.tables_in_schema", json!({ "owner": owner })).await?;
    Ok(res)
}

#[tauri::command]
pub async fn vector_index_list(
    app: AppHandle,
    owner: String,
    table_name: String,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "vector.index_list",
        json!({ "owner": owner, "tableName": table_name }),
    )
    .await?;
    Ok(res)
}

#[tauri::command]
pub async fn object_dataflow_get(
    app: AppHandle,
    owner: String,
    object_type: String,
    object_name: String,
) -> Result<DataFlowResult, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "object.dataflow",
        json!({ "owner": owner, "objectType": object_type, "objectName": object_name }),
    )
    .await?;
    serde_json::from_value(res).map_err(|e| ConnectionTestErr {
        code: -32099,
        message: format!("decode object.dataflow: {e}"),
    })
}

#[tauri::command]
pub async fn explain_plan_get(app: AppHandle, sql: String) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "explain.plan", json!({ "sql": sql })).await?;
    Ok(res)
}

#[tauri::command]
pub async fn proc_describe(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(
        &app,
        "proc.describe",
        json!({ "owner": owner, "name": name }),
    )
    .await?;
    Ok(res)
}

#[tauri::command]
pub async fn proc_execute(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "proc.execute", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn flow_trace_proc(
    app: AppHandle,
    payload: serde_json::Value,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(&app, "flow.trace_proc", payload).await
}

#[tauri::command]
pub async fn flow_trace_sql(
    app: AppHandle,
    payload: serde_json::Value,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(&app, "flow.trace_sql", payload).await
}

#[tauri::command]
pub async fn chart_configure(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "chart.configure", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn chart_reset(app: AppHandle, session_id: String) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "chart.reset", json!({ "sessionId": session_id })).await?;
    Ok(res)
}

// ── PL/SQL Debugger ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn debug_open(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.open", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_get_source(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.get_source", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_start(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.start", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_stop(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.stop", serde_json::json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_step_into(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.step_into", serde_json::json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_step_over(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.step_over", serde_json::json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_step_out(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.step_out", serde_json::json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_continue(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.continue", serde_json::json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_set_breakpoint(
    app: AppHandle,
    payload: Value,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.set_breakpoint", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_remove_breakpoint(
    app: AppHandle,
    payload: Value,
) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.remove_breakpoint", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_get_values(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.get_values", payload).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_get_call_stack(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.get_call_stack", serde_json::json!({})).await?;
    Ok(res)
}

#[tauri::command]
pub async fn debug_run(app: AppHandle, payload: Value) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "debug.run", payload).await?;
    Ok(res)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrdsDetectResult {
    pub installed: bool,
    #[serde(rename = "userHasAccess", default)]
    pub user_has_access: bool,
    pub version: Option<String>,
    #[serde(rename = "currentSchemaEnabled")]
    pub current_schema_enabled: bool,
    #[serde(rename = "hasAdminRole")]
    pub has_admin_role: bool,
    #[serde(rename = "ordsBaseUrl")]
    pub ords_base_url: Option<String>,
}

#[tauri::command]
pub async fn ords_detect(app: AppHandle) -> Result<OrdsDetectResult, ConnectionTestErr> {
    let res = call_sidecar(&app, "ords.detect", json!({})).await?;
    serde_json::from_value(res).map_err(|e| ConnectionTestErr {
        code: -32603,
        message: format!("ords_detect parse error: {}", e),
    })
}

#[tauri::command]
pub async fn session_self(app: AppHandle) -> Result<Value, ConnectionTestErr> {
    call_sidecar(&app, "oracle.session_self", json!({})).await
}

#[tauri::command]
pub async fn ai_approval_resolve(
    app: AppHandle,
    request_id: String,
    approved: bool,
    apply_to_turn: bool,
) -> Result<Value, ConnectionTestErr> {
    call_sidecar(
        &app,
        "ai.approval.resolve",
        json!({
            "requestId": request_id,
            "approved": approved,
            "applyToTurn": apply_to_turn,
        }),
    )
    .await
}

#[tauri::command]
pub async fn ords_modules_list(
    app: AppHandle,
    owner: String,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(&app, "ords.modules.list", json!({ "owner": owner })).await
}

#[tauri::command]
pub async fn ords_module_get(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(
        &app,
        "ords.module.get",
        json!({ "owner": owner, "name": name }),
    )
    .await
}

#[tauri::command]
pub async fn ords_enable_schema(app: AppHandle) -> Result<(), ConnectionTestErr> {
    call_sidecar(&app, "ords.enable_schema", json!({})).await?;
    Ok(())
}

#[tauri::command]
pub async fn ords_module_export_sql(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(
        &app,
        "ords.module.export_sql",
        json!({ "owner": owner, "name": name }),
    )
    .await
}

#[tauri::command]
pub async fn ords_roles_list(app: AppHandle) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(&app, "ords.roles.list", json!({})).await
}

#[tauri::command]
pub async fn ords_generate_sql(
    app: AppHandle,
    config: serde_json::Value,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(&app, "ords.generate_sql", config).await
}

#[tauri::command]
pub async fn ords_apply(
    app: AppHandle,
    config: serde_json::Value,
) -> Result<serde_json::Value, ConnectionTestErr> {
    // Server regenerates SQL from config and executes — closes the
    // privilege-escalation hole where the renderer could submit arbitrary PL/SQL.
    call_sidecar(&app, "ords.apply", config).await
}

use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdsTestResult {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub elapsed_ms: u64,
}

/// Headers the renderer is permitted to set on outbound ORDS test requests.
/// Anything else is silently dropped to prevent a compromised renderer from
/// using this command as a generic HTTP exfil tool with attacker-controlled
/// auth/cookies.
const ORDS_TEST_ALLOWED_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "x-requested-with",
];

#[tauri::command]
pub async fn ords_test_http(
    app: AppHandle,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    fallback_base_url: Option<String>,
) -> Result<OrdsTestResult, ConnectionTestErr> {
    // Authoritative base URL comes from the sidecar (which derives it from the
    // currently-open Oracle session via ORDS metadata) — NOT from the renderer.
    // Closes a renderer-controlled-exfil hole where a compromised UI could pass
    // any allowed_base_url it wanted.
    // Self-hosted ORDS where security.host.url isn't set falls back to the
    // user-supplied base URL (validated as a well-formed http/https URL).
    let detect = call_sidecar(&app, "ords.detect", json!({})).await?;
    let detected_base = detect
        .get("ordsBaseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            fallback_base_url.filter(|s| !s.is_empty()).filter(|s| {
                reqwest::Url::parse(s)
                    .map(|u| matches!(u.scheme(), "http" | "https"))
                    .unwrap_or(false)
            })
        })
        .ok_or_else(|| ConnectionTestErr {
            code: -32603,
            message: "ORDS base URL not detected and no valid fallback provided".to_string(),
        })?;

    let url_obj = reqwest::Url::parse(&url).map_err(|_| ConnectionTestErr {
        code: -32602,
        message: "URL is not a valid absolute HTTPS/HTTP URL".to_string(),
    })?;
    let scheme = url_obj.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ConnectionTestErr {
            code: -32602,
            message: "Only http/https URLs are allowed".to_string(),
        });
    }
    if !url.starts_with(&detected_base) {
        return Err(ConnectionTestErr {
            code: -32603,
            message: format!(
                "URL not under detected ORDS base ({}). Compromised renderer or stale config.",
                detected_base
            ),
        });
    }

    let start = std::time::Instant::now();
    // Cert verification ON (no .danger_accept_invalid_certs).  Self-signed dev ORDS
    // installs need a proper trust store entry; we don't open the door for MITM.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| ConnectionTestErr {
            code: -32603,
            message: format!("HTTP client error: {}", e),
        })?;

    let req_method = match method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        _ => {
            return Err(ConnectionTestErr {
                code: -32602,
                message: format!("Method not supported: {}", method),
            });
        }
    };

    let mut req = client.request(req_method, &url);
    for (k, v) in &headers {
        let name = k.to_ascii_lowercase();
        if !name.is_empty() && ORDS_TEST_ALLOWED_HEADERS.contains(&name.as_str()) {
            req = req.header(k, v);
        }
        // Silently drop disallowed headers — renderer should never have been able
        // to set Cookie, Host, X-Forwarded-*, etc. on an outbound HTTP request.
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| ConnectionTestErr {
        code: -32603,
        message: format!("Request failed: {}", e),
    })?;
    let status = resp.status().as_u16();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.text().await.unwrap_or_default();
    let elapsed_ms = start.elapsed().as_millis() as u64;

    Ok(OrdsTestResult {
        status,
        headers: resp_headers,
        body,
        elapsed_ms,
    })
}

#[tauri::command]
pub async fn ords_clients_list(app: AppHandle) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(&app, "ords.clients.list", json!({})).await
}

#[tauri::command]
pub async fn ords_clients_create(
    app: AppHandle,
    name: String,
    description: String,
    roles: Vec<String>,
) -> Result<serde_json::Value, ConnectionTestErr> {
    call_sidecar(
        &app,
        "ords.clients.create",
        json!({ "name": name, "description": description, "roles": roles }),
    )
    .await
}

#[tauri::command]
pub async fn ords_clients_revoke(app: AppHandle, name: String) -> Result<(), ConnectionTestErr> {
    call_sidecar(&app, "ords.clients.revoke", json!({ "name": name })).await?;
    Ok(())
}

#[tauri::command]
pub async fn dml_preview(app: AppHandle, sql: String) -> Result<Value, ConnectionTestErr> {
    call_sidecar(&app, "dml.preview", json!({ "sql": sql })).await
}

#[tauri::command]
pub async fn unsafe_dml_confirm(
    app: AppHandle,
    summary: String,
) -> Result<bool, ConnectionTestErr> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let safe_summary = summary.chars().take(300).collect::<String>();
    app.dialog()
        .message(format!(
            "You are about to execute a potentially unsafe SQL statement:\n\n{safe_summary}\n\nThis operation cannot be automatically rolled back. Proceed?"
        ))
        .title("Unsafe SQL — Confirm Execution")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Execute Anyway".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    Ok(rx.await.unwrap_or(false))
}

#[tauri::command]
pub async fn confirm_rollback_tx(app: AppHandle) -> Result<bool, ConnectionTestErr> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(
            "You have uncommitted changes in this session.\n\nRolling back will permanently discard all pending DML and DDL changes since your last COMMIT. This action cannot be undone.\n\nProceed with ROLLBACK?"
        )
        .title("Discard Pending Transaction")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Rollback".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    Ok(rx.await.unwrap_or(false))
}

#[tauri::command]
pub async fn perf_stats(app: AppHandle, sql: String) -> Result<Value, ConnectionTestErr> {
    let res = call_sidecar(&app, "perf.stats", json!({ "sql": sql })).await?;
    Ok(res)
}

// ─── Object Version History ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub captured: bool,
}

#[tauri::command]
pub async fn object_version_capture(
    app: AppHandle,
    connection_id: String,
    owner: String,
    object_type: String,
    object_name: String,
    ddl: String,
    reason: String,
) -> CaptureResult {
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    let captured = svc.object_version_capture(
        &connection_id,
        &owner,
        &object_type,
        &object_name,
        &ddl,
        &reason,
    );
    CaptureResult { captured }
}

#[tauri::command]
pub async fn object_version_list(
    app: AppHandle,
    connection_id: String,
    owner: String,
    object_type: String,
    object_name: String,
) -> Result<Vec<crate::persistence::object_versions::ObjectVersionEntry>, ConnectionTestErr> {
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_list(&connection_id, &owner, &object_type, &object_name)
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub diff: String,
}

#[tauri::command]
pub async fn object_version_diff(
    app: AppHandle,
    connection_id: String,
    sha_a: String,
    sha_b: String,
    file_path: String,
) -> Result<DiffResult, ConnectionTestErr> {
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_diff(&connection_id, &sha_a, &sha_b, &file_path)
        .map(|diff| DiffResult { diff })
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

#[derive(Serialize)]
pub struct LoadResult {
    pub ddl: String,
}

#[tauri::command]
pub async fn object_version_load(
    app: AppHandle,
    connection_id: String,
    commit_sha: String,
    file_path: String,
) -> Result<LoadResult, ConnectionTestErr> {
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_load(&connection_id, &commit_sha, &file_path)
        .map(|ddl| LoadResult { ddl })
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

#[tauri::command]
pub async fn object_version_label(
    app: AppHandle,
    connection_id: String,
    version_id: i64,
    owner: String,
    object_type: String,
    object_name: String,
    label: Option<String>,
) -> Result<(), ConnectionTestErr> {
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_set_label(
        &connection_id,
        version_id,
        &owner,
        &object_type,
        &object_name,
        label.as_deref(),
    )
    .map_err(|e| ConnectionTestErr {
        code: e.code,
        message: e.message,
    })
}

#[tauri::command]
pub async fn object_version_set_remote(
    app: AppHandle,
    connection_id: String,
    remote_url: String,
    pat: String,
) -> Result<(), ConnectionTestErr> {
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_set_remote(&connection_id, &remote_url, &pat)
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub pushed_commits: u32,
}

#[tauri::command]
pub async fn object_version_push(
    app: AppHandle,
    connection_id: String,
) -> Result<PushResult, ConnectionTestErr> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_err());
    }
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_push(&connection_id)
        .map(|pushed_commits| PushResult { pushed_commits })
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRemoteResult {
    pub url: Option<String>,
}

#[tauri::command]
pub async fn object_version_get_remote(
    app: AppHandle,
    connection_id: String,
) -> Result<GetRemoteResult, ConnectionTestErr> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_err());
    }
    let svc = app.state::<crate::persistence::connections::ConnectionService>();
    svc.object_version_get_remote(&connection_id)
        .map(|url| GetRemoteResult { url })
        .map_err(|e| ConnectionTestErr {
            code: e.code,
            message: e.message,
        })
}

#[tauri::command]
pub async fn auth_token_get(app: AppHandle) -> Result<Option<String>, String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    crate::persistence::secrets::get_auth_token().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_token_set(app: AppHandle, token: String) -> Result<(), String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    crate::persistence::secrets::set_auth_token(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_token_clear(app: AppHandle) -> Result<(), String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    crate::persistence::secrets::delete_auth_token().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_api_get(
    app: AppHandle,
    path: String,
    params: Option<std::collections::HashMap<String, String>>,
) -> Result<Value, String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    let token = crate::persistence::secrets::get_auth_token()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not_authenticated".to_string())?;

    let base = "https://api.veesker.cloud";
    let url = format!("{}{}", base, path);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url).bearer_auth(&token);
    if let Some(p) = params {
        req = req.query(&p.into_iter().collect::<Vec<_>>());
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body: Value = res.json().await.map_err(|e| e.to_string())?;

    if status == 403 {
        return Err("forbidden".to_string());
    }
    if status >= 400 {
        return Err(format!("server_error_{}", status));
    }
    Ok(body)
}

#[tauri::command]
pub async fn cloud_api_post(app: AppHandle, path: String, body: Value) -> Result<(), String> {
    if airgap_active(&app).await {
        return Err(airgap_blocked_string());
    }
    let token = crate::persistence::secrets::get_auth_token()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not_authenticated".to_string())?;

    let url = format!("https://api.veesker.cloud{}", path);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if status >= 400 {
        return Err(format!("server_error_{}", status));
    }
    Ok(())
}

// Sprint D Onda D.1 — Command Window history + script reader.
//
// Three thin commands consumed by the renderer's Command Window REPL:
//   * `command_history_load`   — page through recent submitted lines
//   * `command_history_append` — record one submitted line after execution
//   * `command_script_read`    — read a `@file.sql` script from disk

use crate::persistence::command_history::{CommandHistoryEntry, LoadResult as CommandHistoryRaw};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryLoadResult {
    pub entries: Vec<CommandHistoryEntry>,
    pub inaccessible_count: usize,
    pub history_disabled: bool,
}

#[tauri::command]
pub async fn command_history_load(
    app: AppHandle,
    connection_id: String,
    limit: i64,
) -> Result<CommandHistoryLoadResult, String> {
    let svc = app.state::<ConnectionService>();
    let raw: CommandHistoryRaw = svc
        .command_history_load(&connection_id, limit)
        .map_err(|e| e.message)?;
    Ok(CommandHistoryLoadResult {
        entries: raw.entries,
        inaccessible_count: raw.inaccessible_count,
        history_disabled: raw.history_disabled,
    })
}

#[tauri::command]
pub async fn command_history_append(
    app: AppHandle,
    connection_id: String,
    command: String,
    origin: String,
    status: String,
    duration_ms: Option<i64>,
) -> Result<i64, String> {
    let svc = app.state::<ConnectionService>();
    svc.command_history_append(&connection_id, &command, &origin, &status, duration_ms)
        .map_err(|e| e.message)
}

#[tauri::command]
pub async fn command_history_clear_inaccessible(app: AppHandle) -> Result<i64, String> {
    let svc = app.state::<ConnectionService>();
    svc.command_history_clear_inaccessible()
        .map_err(|e| e.message)
}

const COMMAND_SCRIPT_MAX_BYTES: u64 = 1024 * 1024;

#[tauri::command]
pub async fn command_script_read(app: AppHandle, path: String) -> Result<String, String> {
    if path.is_empty() {
        return Err("path required".to_string());
    }
    // Reject any path containing parent-dir segments. We check the raw input
    // (before canonicalize) so a renderer cannot smuggle `..` past the user's
    // own scope-allow-list — the canonical form would silently flatten them.
    let raw = Path::new(&path);
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path traversal segments ('..') are not allowed".to_string());
    }
    // Confine reads to the same user folders the renderer is already allowed
    // to browse (Documents, Desktop, Downloads, Home, app data/config).
    let canon = validate_user_path(&app, &path).map_err(|e| e.message)?;
    let meta = std::fs::metadata(&canon)
        .map_err(|e| format!("SP2-0310: unable to open file \"{path}\": {e}"))?;
    if !meta.is_file() {
        return Err(format!("SP2-0310: \"{path}\" is not a regular file"));
    }
    if meta.len() > COMMAND_SCRIPT_MAX_BYTES {
        return Err(format!(
            "script file is {} bytes, exceeds the 1 MiB limit",
            meta.len()
        ));
    }
    std::fs::read_to_string(&canon)
        .map_err(|e| format!("SP2-0310: unable to read file \"{path}\": {e}"))
}
