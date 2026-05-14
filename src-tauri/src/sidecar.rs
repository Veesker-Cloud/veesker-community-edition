// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::{Mutex, mpsc, oneshot};
use uuid::Uuid;

/// Locate the directory containing oracledb's native `.node` binding for the current
/// platform. Tries (in order): explicit env var, dev-mode node_modules path, bundled
/// resources next to the sidecar binary. Returns None if nothing is found — the sidecar
/// will then run in Thin mode.
fn resolve_oracledb_binding_dir(app: &AppHandle) -> Option<String> {
    if let Ok(explicit) = std::env::var("VEESKER_ORACLEDB_BINARY_DIR")
        && PathBuf::from(&explicit).is_dir()
    {
        return Some(explicit);
    }
    // Dev mode: walk up from CARGO_MANIFEST_DIR (set when running cargo) to find the repo's
    // sidecar/node_modules/oracledb/build/Release directory.
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let dev = PathBuf::from(manifest)
            .join("..")
            .join("sidecar")
            .join("node_modules")
            .join("oracledb")
            .join("build")
            .join("Release");
        if dev.is_dir() {
            return dev.canonicalize().ok().map(strip_extended_prefix);
        }
    }
    // Production: look for `oracledb-bindings/` in resource_dir alongside the bundled app.
    if let Ok(res_dir) = app.path().resource_dir() {
        let prod = res_dir.join("oracledb-bindings");
        if prod.is_dir() {
            return prod.canonicalize().ok().map(strip_extended_prefix);
        }
    }
    None
}

/// Locate the directory containing the duckdb runtime shared library for the current
/// platform (`duckdb.dll` on Windows, `libduckdb.dylib` on macOS, `libduckdb.so` on
/// Linux). Bun's --compile bundles duckdb.node into the binary's virtual filesystem;
/// at runtime the .node is extracted to a temp dir and the dynamic loader tries to
/// resolve its sibling shared library — which is NOT extracted by Bun. The load
/// fails with ERR_DLOPEN_FAILED. We work around this by ensuring the shared library
/// is reachable via the spawned process's loader search path (PATH on Windows,
/// DYLD_FALLBACK_LIBRARY_PATH on macOS, LD_LIBRARY_PATH on Linux).
fn resolve_duckdb_binding_dir(app: &AppHandle) -> Option<String> {
    let lib_name: &str = if cfg!(windows) {
        "duckdb.dll"
    } else if cfg!(target_os = "macos") {
        "libduckdb.dylib"
    } else {
        "libduckdb.so"
    };

    // Dev mode: src-tauri/binaries/<lib_name> (populated by scripts/copy-duckdb-binding.ts
    // before every cargo/tauri build).
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let dev = PathBuf::from(manifest).join("binaries");
        if dev.join(lib_name).is_file() {
            return dev.canonicalize().ok().map(strip_extended_prefix);
        }
    }
    // Production: bundled into resource_dir/binaries/ via tauri.conf.json bundle.resources.
    if let Ok(res_dir) = app.path().resource_dir() {
        let prod = res_dir.join("binaries");
        if prod.join(lib_name).is_file() {
            return prod.canonicalize().ok().map(strip_extended_prefix);
        }
    }
    None
}

/// On Windows, std::fs::canonicalize returns paths with the `\\?\` extended-length prefix.
/// Node.js's require() and oracledb's binary loader can't handle that format and fail
/// silently with NJS-045. Strip the prefix so we pass plain `C:\foo\bar` style paths.
fn strip_extended_prefix(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
}

#[derive(Debug, Serialize)]
struct Request<'a> {
    jsonrpc: &'a str,
    id: String,
    method: &'a str,
    params: Value,
}

#[derive(Debug, Deserialize)]
pub struct Response {
    pub id: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<RpcError>,
}

/// JSON-RPC 2.0 notification: like a request but with no `id` field, so the
/// server (sidecar) doesn't expect a reply. The sidecar uses these to push
/// async events to the host (e.g. `sandbox.revoked`). We forward the `method`
/// and `params` to the renderer as a Tauri event so frontends can `listen()`.
#[derive(Debug, Deserialize)]
struct Notification {
    #[allow(dead_code)] // jsonrpc field is part of the protocol but unused here
    jsonrpc: Option<String>,
    method: String,
    params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    // Per JSON-RPC 2.0: optional Primitive/Structured error metadata. Not currently
    // surfaced to the renderer but kept for protocol completeness and future telemetry.
    #[serde(default)]
    #[allow(dead_code)]
    pub data: Option<Value>,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>>;

pub struct Sidecar {
    stdin_tx: mpsc::Sender<String>,
    pending: Pending,
    _child: Arc<Mutex<CommandChild>>,
}

impl Sidecar {
    pub fn spawn(app: &AppHandle) -> Result<Self, String> {
        // Tell the sidecar where the node-oracledb native binding (.node) lives. Bun's
        // --compile cannot bundle the .node file (oracledb uses a dynamic require path
        // the bundler can't trace), so we ship the file alongside the binary and pass
        // its directory via env var. The sidecar passes this to oracledb.initOracleClient
        // as `binaryDir`. Without this, Thick mode fails with NJS-045 at runtime.
        let mut cmd = app
            .shell()
            .sidecar("veesker-sidecar")
            .map_err(|e| format!("sidecar binary not found: {e}"))?;

        if let Some(dir) = resolve_oracledb_binding_dir(app) {
            cmd = cmd.env("VEESKER_ORACLEDB_BINARY_DIR", dir);
        }

        // Prepend the directory containing the duckdb runtime shared library to the
        // dynamic-loader search path so the OS can find it when Bun extracts duckdb.node
        // from the sidecar binary's virtual filesystem to a temp dir at runtime. The env
        // var differs per OS:
        //   - Windows: PATH (LoadLibrary search order)
        //   - macOS:   DYLD_FALLBACK_LIBRARY_PATH (dlopen fallback; honored under SIP,
        //              unlike DYLD_LIBRARY_PATH which is stripped from sandboxed/hardened
        //              processes). When this app is notarized in the future the env-var
        //              approach may break entirely — tracked as tech debt.
        //   - Linux:   LD_LIBRARY_PATH (ld.so search path)
        if let Some(duckdb_dir) = resolve_duckdb_binding_dir(app) {
            let (env_var, separator) = if cfg!(windows) {
                ("PATH", ";")
            } else if cfg!(target_os = "macos") {
                ("DYLD_FALLBACK_LIBRARY_PATH", ":")
            } else {
                ("LD_LIBRARY_PATH", ":")
            };
            let current = std::env::var(env_var).unwrap_or_default();
            let new_value = if current.is_empty() {
                duckdb_dir
            } else {
                format!("{duckdb_dir}{separator}{current}")
            };
            cmd = cmd.env(env_var, new_value);
        }

        // Where the sidecar writes its rotating log file. We point it at
        // <app_data>/logs/sidecar.log so users can attach the file when
        // reporting bugs without us having to surface a separate UI.
        if let Ok(data_dir) = app.path().app_data_dir() {
            let log_dir = data_dir.join("logs");
            if std::fs::create_dir_all(&log_dir).is_ok() {
                cmd = cmd.env("VEESKER_LOG_DIR", log_dir.to_string_lossy().into_owned());
            }
        }

        let (mut rx, child) = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(32);
        let child = Arc::new(Mutex::new(child));

        // Forward stdin writes
        let stdin_writer = child.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                let mut guard = stdin_writer.lock().await;
                if let Err(err) = guard.write(line.as_bytes()) {
                    eprintln!("sidecar stdin write failed: {err}");
                    break;
                }
            }
        });

        // Demux stdout into pending oneshots. Stdout chunks may split a JSON line
        // across events, so accumulate in a buffer and only consume complete lines.
        let pending_clone = pending.clone();
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut buffer = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(idx) = buffer.find('\n') {
                            let line = buffer[..idx].trim().to_string();
                            buffer.drain(..=idx);
                            if line.is_empty() {
                                continue;
                            }
                            // JSON-RPC: notifications have no `id`, responses always do.
                            // Try notification first — if the line carries a `method` field,
                            // it is structurally a notification and we forward it to the
                            // renderer as a Tauri event under the JSON-RPC method name
                            // (e.g. "sandbox.revoked" → frontend's `listen("sandbox-revoked", …)`).
                            //
                            // Tauri 2's app.emit() validates event names against
                            // [A-Za-z0-9-/:_] — the JSON-RPC convention uses dotted
                            // method names. Normalize '.' to '-' so the renderer can
                            // listen with valid Tauri event names without forcing the
                            // sidecar to mirror Tauri's char rules in its method names.
                            if let Ok(notification) = serde_json::from_str::<Notification>(&line) {
                                let event_name = notification.method.replace('.', "-");
                                if let Err(err) = app_clone.emit(&event_name, &notification.params)
                                {
                                    eprintln!(
                                        "sidecar notification emit failed: method={} event={} err={}",
                                        notification.method, event_name, err
                                    );
                                }
                                continue;
                            }
                            match serde_json::from_str::<Response>(&line) {
                                Ok(resp) => {
                                    let mut map = pending_clone.lock().await;
                                    if let Some(tx) = map.remove(&resp.id) {
                                        let _ = tx.send(resp);
                                    }
                                }
                                Err(err) => {
                                    eprintln!("sidecar bad json: {err} line={line}");
                                }
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            eprintln!("[sidecar] {}", text.trim_end());
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        eprintln!("sidecar terminated: {:?}", payload);
                        // Wake any in-flight callers — dropping their senders
                        // resolves rx.await to RecvError, which call() maps to -32002.
                        pending_clone.lock().await.clear();
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(Self {
            stdin_tx,
            pending,
            _child: child,
        })
    }

    /// JSON-RPC call with no Tauri-side timeout. Long-running queries (which were
    /// previously capped by a 120s host-side timeout, masking otherwise-successful
    /// results) now run as long as the sidecar takes. Cancellation is handled by:
    ///   - `query.cancel` RPC (matches by requestId, sends OCI break())
    ///   - `statementTimeoutMs` on the Oracle session (server-side timeout)
    ///   - sidecar process death (Terminated event clears pending senders → -32002)
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = Uuid::new_v4().to_string();
        let req = Request {
            jsonrpc: "2.0",
            id: id.clone(),
            method,
            params,
        };
        let mut line = serde_json::to_string(&req).expect("serialize request");
        line.push('\n');

        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().await;
            map.insert(id.clone(), tx);
        }

        if let Err(err) = self.stdin_tx.send(line).await {
            self.pending.lock().await.remove(&id);
            return Err(RpcError {
                code: -32001,
                message: format!("sidecar stdin closed: {err}"),
                data: None,
            });
        }

        let resp = rx.await.map_err(|_| RpcError {
            code: -32002,
            message: "sidecar dropped response channel (process likely terminated)".into(),
            data: None,
        })?;

        if let Some(err) = resp.error {
            return Err(err);
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }
}

/// Holds an `Arc<Sidecar>` once spawned. The Mutex is only contended during the
/// brief lazy-init window — after that, callers clone the Arc out of the lock
/// in microseconds and use it without any cross-call serialization.
///
/// This is the fix for the bug where holding the Mutex across `sidecar.call()`
/// .await serialized every Tauri RPC behind any in-progress query — including
/// `query.cancel`, which made cancel buttons completely non-functional during
/// long queries.
pub struct SidecarState(pub Mutex<Option<Arc<Sidecar>>>);

/// Acquire (or lazily spawn) the sidecar and return a cloned Arc. The Mutex is
/// dropped before the Arc is returned, so every caller can hold/use the Arc
/// concurrently.
pub async fn acquire(app: &AppHandle) -> Result<Arc<Sidecar>, String> {
    let state = app.state::<SidecarState>();
    let mut guard = state.0.lock().await;
    if guard.is_none() {
        *guard = Some(Arc::new(Sidecar::spawn(app)?));
    }
    Ok(guard.as_ref().expect("just inserted").clone())
}

/// Public helper so tray and other non-command modules can call the sidecar.
/// Now uses the cheap-Arc-clone path, so it doesn't serialize against
/// in-flight long-running queries.
pub async fn call_raw(
    app: &AppHandle,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, RpcError> {
    let sc = acquire(app).await.map_err(|msg| RpcError {
        code: -32003,
        message: msg,
        data: None,
    })?;
    sc.call(method, params).await
}
