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
    let mut cmd = CommandBuilder::new(shell);
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
    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    store: tauri::State<'_, TerminalStore>,
    id: String,
    data: String,
) -> Result<(), String> {
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
