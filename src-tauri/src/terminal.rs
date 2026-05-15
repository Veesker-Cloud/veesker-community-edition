// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

static TERMINAL_SESSION_CONFIRMED: Mutex<bool> = Mutex::new(false);

#[tauri::command]
pub fn terminal_confirm_session() -> Result<(), String> {
    let mut guard = TERMINAL_SESSION_CONFIRMED
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    *guard = true;
    Ok(())
}

/// F-C-001 (security audit 2026-05-14): revoke a previously-granted
/// terminal-session confirmation. The renderer is expected to call this
/// on workspace close, on logout, and any time the user's trust
/// expectation should reset. Pairs with terminal_confirm_session.
///
/// Without this command, the original sticky-process-global flag meant a
/// single confirmation lasted the entire app lifetime, even after the
/// user closed the workspace or logged out of cloud.
#[tauri::command]
pub fn terminal_revoke_session() -> Result<(), String> {
    let mut guard = TERMINAL_SESSION_CONFIRMED
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    *guard = false;
    Ok(())
}

/// F-C-001: hard-disable terminal commands via env var. Operators deploying
/// Veesker into a managed/locked-down environment can set
/// `VEESKER_DISABLE_TERMINAL=1` to fail every terminal_* command regardless
/// of UI state. Returns true when the env var disables terminals.
fn terminal_hard_disabled() -> bool {
    matches!(
        std::env::var("VEESKER_DISABLE_TERMINAL").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

// portable-pty's MasterPty doesn't carry a Send bound in its trait definition,
// but all concrete implementations (ConPtyMasterPty on Windows, UnixMasterPty
// on macOS/Linux) use OS-level thread-safe handles internally. Access is always
// serialized through a Mutex, making the wrapper safe.
struct SendMaster(Box<dyn portable_pty::MasterPty>);
unsafe impl Send for SendMaster {}

pub struct TerminalEntry {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<SendMaster>,
}

pub type TerminalStore = Arc<Mutex<HashMap<String, Arc<TerminalEntry>>>>;

pub fn new_store() -> TerminalStore {
    Arc::new(Mutex::new(HashMap::new()))
}

fn detect_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        // Prefer PowerShell; fall back to cmd.exe
        let ps = std::process::Command::new("where")
            .arg("powershell")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ps {
            return "powershell".to_string();
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string())
}

#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    store: tauri::State<'_, TerminalStore>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    // F-C-001: hard env-var disable wins over every other check.
    if terminal_hard_disabled() {
        return Err("terminal_disabled_by_env".into());
    }
    {
        let guard = TERMINAL_SESSION_CONFIRMED
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if !*guard {
            return Err("user_confirmation_required".into());
        }
    }

    let id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = detect_shell();
    let mut cmd = CommandBuilder::new(shell.clone());
    cmd.cwd(home_dir());

    pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id_clone = id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&format!("terminal:data:{}", id_clone), data);
                }
            }
        }
        let _ = app_clone.emit(&format!("terminal:exit:{}", id_clone), ());
    });

    let entry = Arc::new(TerminalEntry {
        writer: Mutex::new(writer),
        master: Mutex::new(SendMaster(pair.master)),
    });

    store.lock().unwrap().insert(id.clone(), entry);

    // F-C-001: emit an audit-trail event for every terminal spawn. The
    // event lives only in the live `terminal:created` channel for now —
    // it is NOT written to the AES-GCM audit JSONL because the terminal
    // contents legitimately include shell history that a user wouldn't
    // expect to be persisted. The event lets the renderer log to its
    // session-scoped UI audit panel.
    let _ = app.emit(
        "terminal:created",
        serde_json::json!({
            "id": id,
            "shell": shell,
            "cols": cols,
            "rows": rows,
            "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }),
    );

    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    store: tauri::State<'_, TerminalStore>,
    id: String,
    data: String,
) -> Result<(), String> {
    // F-C-001: re-check both the hard-disable and the confirmation flag on
    // EVERY write. terminal_create only checks once; without this re-check
    // a hostile renderer that obtained a session id (via stored XSS, a
    // crafted AI suggestion that bypassed CSP, etc.) could keep writing
    // after `terminal_revoke_session` was called by the workspace-close
    // handler.
    if terminal_hard_disabled() {
        return Err("terminal_disabled_by_env".into());
    }
    {
        let guard = TERMINAL_SESSION_CONFIRMED
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if !*guard {
            return Err("user_confirmation_required".into());
        }
    }
    let map = store.lock().unwrap();
    if let Some(entry) = map.get(&id) {
        let mut w = entry.writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    store: tauri::State<'_, TerminalStore>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = store.lock().unwrap();
    if let Some(entry) = map.get(&id) {
        let m = entry.master.lock().unwrap();
        m.0.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_close(store: tauri::State<'_, TerminalStore>, id: String) -> Result<(), String> {
    store.lock().unwrap().remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_flag() {
        if let Ok(mut g) = TERMINAL_SESSION_CONFIRMED.lock() {
            *g = false;
        }
    }

    #[test]
    fn confirm_then_revoke_round_trip() {
        reset_flag();
        // Initially unconfirmed
        assert_eq!(*TERMINAL_SESSION_CONFIRMED.lock().unwrap(), false);
        terminal_confirm_session().unwrap();
        assert_eq!(*TERMINAL_SESSION_CONFIRMED.lock().unwrap(), true);
        terminal_revoke_session().unwrap();
        assert_eq!(*TERMINAL_SESSION_CONFIRMED.lock().unwrap(), false);
    }

    #[test]
    fn hard_disable_env_var_matches_truthy_values() {
        // Save current value
        let prev = std::env::var("VEESKER_DISABLE_TERMINAL").ok();

        for v in ["1", "true", "TRUE", "yes", "YES"] {
            // SAFETY: tests are #[cfg(test)] single-threaded by default;
            // env mutation is safe within this test scope.
            unsafe { std::env::set_var("VEESKER_DISABLE_TERMINAL", v); }
            assert!(terminal_hard_disabled(), "env={v} should disable");
        }
        for v in ["", "0", "false", "no", "off"] {
            unsafe { std::env::set_var("VEESKER_DISABLE_TERMINAL", v); }
            assert!(!terminal_hard_disabled(), "env={v} should NOT disable");
        }

        // Restore
        match prev {
            Some(v) => unsafe { std::env::set_var("VEESKER_DISABLE_TERMINAL", v); },
            None => unsafe { std::env::remove_var("VEESKER_DISABLE_TERMINAL"); },
        }
    }
}
