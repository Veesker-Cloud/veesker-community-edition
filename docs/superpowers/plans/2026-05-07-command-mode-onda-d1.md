# Sprint D Onda D.1 — Core REPL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working Command Window tab in Veesker CE that runs SQL/PLSQL via REPL with Tier-1 SQL*Plus directives (SET basics, DESC, /, ;, EXIT, COMMIT/ROLLBACK, PROMPT, @file.sql), reusing the existing executeStatement pipeline so audit chain, AI approval, TRUNCATE confirm, Dry Run, PSDPM hard-lock, and encryption-at-rest all apply.

**Architecture:** New `tab.kind: 'sql' | 'command'` branch in the SqlDrawer + a `CommandWindow.svelte` host that mounts xterm.js with a handcrafted local-echo line editor. A pure-TS `command/` folder owns parser, executor, formatter, state, history, prompt, and script-runner. SQL/PLSQL execution funnels through a new exported `runStatementShared(sql, opts)` extracted from `sql-editor.svelte.ts` so the Command Window never bypasses safety. Per-connection command history persists in SQLCipher-encrypted `veesker.db` via migration v7.

**Tech Stack:** Svelte 5 runes, xterm.js + addon-fit (already in project), Tauri 2 commands (Rust + rusqlite), Bun sidecar (no new RPCs — reuses `oracle.execute` / `oracle.describe`), Vitest for frontend unit tests.

**Spec:** `docs/superpowers/specs/2026-05-07-command-mode-design.md` (commit `cc76ab7`).

**Out of scope for D.1 (deferred):**
- Bind variables (VAR/EXEC/PRINT) — D.2
- Substitution variables (&var, DEFINE/UNDEFINE/ACCEPT) — D.2
- SPOOL, WHENEVER SQLERROR/OSERROR — D.2
- COL FORMAT, BREAK, COMPUTE, AUTOTRACE — D.3
- LIST/SAVE/STORE/RUN/EDIT buffer manipulation — D.3
- Sub-tabs Dialog/Editor split — D.3
- AcceptModal, complex error recovery — D.2

---

## File Structure

### New (D.1)

| Path | Responsibility |
|---|---|
| `ce/src/lib/command/types.ts` | Shared types — `CommandSettings`, `CommandTabState`, `Parsed` discriminated union, `SharedExecResult` |
| `ce/src/lib/command/parser.ts` | `parse(line, ctx) → Parsed`. Lookup table of Tier-1 directives + SQL/`/` block detection |
| `ce/src/lib/command/formatter.ts` | `formatRows(rows, columns, settings) → string` LINESIZE/PAGESIZE-aware ASCII tabular |
| `ce/src/lib/command/state.svelte.ts` | `createCommandState()` factory returning a `$state`-bound object; defaults match SQL\*Plus |
| `ce/src/lib/command/prompt.ts` | `formatPrompt(line: number) → string` for `SQL>` / `  2` / `  3` continuation |
| `ce/src/lib/command/line-editor.ts` | `createLineEditor(term, opts)` — handles cursor, history nav, paste, Ctrl+C/L; emits `submit(line)` |
| `ce/src/lib/command/history.ts` | `loadHistory(connectionId)` / `appendHistory(...)` Tauri wrappers |
| `ce/src/lib/command/script-runner.ts` | `runScript(path, ctx)` — reads file via Tauri fs, iterates lines, dispatches to executor |
| `ce/src/lib/command/executor.ts` | `executeParsed(parsed, state, ctx)` — directive handlers + SQL/PLSQL routing |
| `ce/src/lib/workspace/CommandWindow.svelte` | Top-level Command Window component (xterm host + state owner) |
| `ce/src/lib/command/parser.test.ts` | Vitest unit tests |
| `ce/src/lib/command/formatter.test.ts` | Vitest unit tests |
| `ce/src/lib/command/prompt.test.ts` | Vitest unit tests |
| `ce/src/lib/command/state.test.ts` | Vitest unit tests |
| `ce/src/lib/command/line-editor.test.ts` | Vitest unit tests |

### Modified (D.1)

| Path | Change |
|---|---|
| `ce/src-tauri/src/persistence/store.rs` | Migration v7: `command_history` table + index |
| `ce/src-tauri/src/commands.rs` | New: `command_history_load`, `command_history_append`, `command_script_read` |
| `ce/src-tauri/src/lib.rs` (or `main.rs`) | Register the 3 new commands in the invoke handler |
| `ce/src/lib/stores/sql-editor.svelte.ts` | Add `kind: 'sql' \| 'command'` to `SqlTab`. New `openCommand(connectionId)`. Extract `runStatementShared(sql, opts)` from `runActive()` |
| `ce/src/lib/workspace/SqlDrawer.svelte` | Switch render by `tab.kind`. New tab dropdown menu with "New Command Window" item |
| `ce/src/routes/workspace/[id]/+page.svelte` | Bind keyboard shortcut Ctrl+Shift+N → `sqlEditor.openCommand()` |

---

## Task List

### Task 1: Add migration v7 — `command_history` table

**Files:**
- Modify: `ce/src-tauri/src/persistence/store.rs` (around line 226, end of `add_safety_columns_if_missing`)

- [ ] **Step 1.1: Write the failing migration test**

Add to the `#[cfg(test)] mod tests` section near other migration tests:

```rust
#[test]
fn migration_creates_command_history_table() {
    let conn = Connection::open_in_memory().unwrap();
    init_db(&conn).unwrap();
    assert!(table_exists(&conn, "command_history").unwrap());
    let mut stmt = conn.prepare("PRAGMA table_info(command_history)").unwrap();
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for col in ["id", "connection_id", "command", "executed_at", "session_id", "origin"] {
        assert!(names.iter().any(|n| n == col), "missing column {col}");
    }
}
```

- [ ] **Step 1.2: Run test to verify it fails**

```powershell
cd ce/src-tauri
cargo test --lib persistence::store::tests::migration_creates_command_history_table
```

Expected: FAIL with `assertion 'left == true' failed` (table doesn't exist yet).

- [ ] **Step 1.3: Add migration helper**

Inside `add_safety_columns_if_missing` in `store.rs`, append before the final `Ok(())`:

```rust
    // Sprint D Onda 1 — command_history table for Command Window REPL.
    // SQLCipher (Onda 1.B) encrypts the file at rest; no per-row crypto.
    if !table_exists(conn, "command_history")? {
        conn.execute_batch(
            "CREATE TABLE command_history (\
                id            INTEGER PRIMARY KEY AUTOINCREMENT,\
                connection_id TEXT    NOT NULL,\
                command       TEXT    NOT NULL,\
                executed_at   INTEGER NOT NULL,\
                session_id    TEXT    NOT NULL,\
                origin        TEXT    NOT NULL\
            );\
            CREATE INDEX idx_cmd_hist_conn_time ON command_history(connection_id, executed_at DESC);",
        )?;
    }
```

Note: `connection_id` is `TEXT` to match the existing `connections.id` column type (verified via `grep "id TEXT" store.rs`).

- [ ] **Step 1.4: Run test to verify it passes**

```powershell
cargo test --lib persistence::store::tests::migration_creates_command_history_table
```

Expected: PASS.

- [ ] **Step 1.5: Run all store tests to confirm idempotency**

```powershell
cargo test --lib persistence::store
```

Expected: all pass (including `migration_is_idempotent`).

- [ ] **Step 1.6: Commit**

```powershell
git add src-tauri/src/persistence/store.rs
git commit -m "feat(sprint-d): add command_history table migration (D.1)"
```

---

### Task 2: Add Tauri commands `command_history_load`, `command_history_append`, `command_script_read`

**Files:**
- Modify: `ce/src-tauri/src/commands.rs`
- Modify: `ce/src-tauri/src/lib.rs`

- [ ] **Step 2.1: Add types and handlers in `commands.rs`**

Append at end of the file (after the last `#[tauri::command]`):

```rust
// ─── Sprint D Onda 1 — Command Window history & script read ─────────────────

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct CommandHistoryEntry {
    pub id: i64,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub command: String,
    #[serde(rename = "executedAt")]
    pub executed_at: i64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub origin: String,
}

#[tauri::command]
pub async fn command_history_load(
    app: AppHandle,
    connection_id: String,
    limit: i64,
) -> Result<Vec<CommandHistoryEntry>, String> {
    let svc = app.state::<crate::services::ConnectionService>();
    let conn = svc.db().lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, connection_id, command, executed_at, session_id, origin \
             FROM command_history \
             WHERE connection_id = ? \
             ORDER BY executed_at DESC \
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![connection_id, limit], |r| {
            Ok(CommandHistoryEntry {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                command: r.get(2)?,
                executed_at: r.get(3)?,
                session_id: r.get(4)?,
                origin: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn command_history_append(
    app: AppHandle,
    connection_id: String,
    command: String,
    session_id: String,
    origin: String,
) -> Result<i64, String> {
    let svc = app.state::<crate::services::ConnectionService>();
    let conn = svc.db().lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO command_history (connection_id, command, executed_at, session_id, origin) \
         VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![connection_id, command, now, session_id, origin],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub async fn command_script_read(path: String) -> Result<String, String> {
    use std::path::PathBuf;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("SP2-0310: unable to open file \"{path}\""));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("SP2-0310: unable to open file \"{path}\": {e}"))
}
```

**Important:** Verify that `services::ConnectionService` exposes `pub fn db(&self) -> &std::sync::Mutex<rusqlite::Connection>`. If it doesn't, check the existing `history_list` implementation (line 689 in commands.rs) for the actual accessor pattern and mirror it.

If the actual pattern is `svc.history_list(...)` going through methods, expose two new methods on `ConnectionService` instead:

```rust
// in services.rs
pub fn command_history_load(&self, connection_id: &str, limit: i64) -> Result<Vec<CommandHistoryEntry>, ConnectionError> { ... }
pub fn command_history_append(&self, connection_id: &str, command: &str, session_id: &str, origin: &str) -> Result<i64, ConnectionError> { ... }
```

Read `commands.rs:689-758` and `services.rs` first to pick the right pattern.

- [ ] **Step 2.2: Register handlers in `lib.rs` invoke handler**

Find the `tauri::generate_handler![...]` macro and add the three new functions to the list, e.g.:

```rust
tauri::generate_handler![
    // ...existing handlers...
    crate::commands::command_history_load,
    crate::commands::command_history_append,
    crate::commands::command_script_read,
]
```

- [ ] **Step 2.3: Build to confirm compilation**

```powershell
cd ce/src-tauri
cargo check
```

Expected: clean compile, no warnings.

- [ ] **Step 2.4: Commit**

```powershell
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/services.rs
git commit -m "feat(sprint-d): add command_history_load/append + command_script_read tauri cmds (D.1)"
```

---

### Task 3: Create `command/types.ts` — shared types

**Files:**
- Create: `ce/src/lib/command/types.ts`

- [ ] **Step 3.1: Write the file**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { ColumnMeta } from "$lib/sql-query";

export interface CommandSettings {
  linesize: number;     // 1..32767 default 80
  pagesize: number;     // 0..50000 default 14
  feedback: boolean;    // default true
  echo: boolean;        // default false (only relevant for @scripts)
  timing: boolean;      // default false
  heading: boolean;     // default true
  serveroutput: boolean; // default true (Onda 3 already enabled DBMS_OUTPUT)
  termout: boolean;     // default true
  null: string;         // default "" (rendered for NULL values)
  colsep: string;       // default " "
  numwidth: number;     // default 10
  verify: boolean;      // default true (only matters once D.2 lands)
  trimspool: boolean;   // default false (D.2 SPOOL relies on it)
  trimout: boolean;     // default true
  wrap: boolean;        // default true
}

export const DEFAULT_SETTINGS: CommandSettings = {
  linesize: 80,
  pagesize: 14,
  feedback: true,
  echo: false,
  timing: false,
  heading: true,
  serveroutput: true,
  termout: true,
  null: "",
  colsep: " ",
  numwidth: 10,
  verify: true,
  trimspool: false,
  trimout: true,
  wrap: true,
};

export type Parsed =
  | { kind: "directive"; name: string; args: string[]; raw: string }
  | { kind: "sql_partial"; line: string }
  | { kind: "sql_complete"; sql: string }
  | { kind: "block_partial"; line: string }
  | { kind: "block_complete"; sql: string }
  | { kind: "execute_buffer" }
  | { kind: "empty" }
  | { kind: "parse_error"; code: string; msg: string };

export interface CommandHistoryEntry {
  id: number;
  connectionId: string;
  command: string;
  executedAt: number;
  sessionId: string;
  origin: "user_typed" | "ai_approved" | "script_executed" | string;
}

export interface SharedExecResult {
  rows: any[][];
  columns: ColumnMeta[];
  rowCount: number;
  elapsedMs: number;
  dbmsOutput: string[];
  error: { code: number; message: string } | null;
}
```

- [ ] **Step 3.2: Commit**

```powershell
git add src/lib/command/types.ts
git commit -m "feat(sprint-d): add command/types.ts shared types (D.1)"
```

---

### Task 4: Create `command/prompt.ts` + tests

**Files:**
- Create: `ce/src/lib/command/prompt.ts`
- Create: `ce/src/lib/command/prompt.test.ts`

- [ ] **Step 4.1: Write the failing test first**

`prompt.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { formatPrompt } from "./prompt";

describe("formatPrompt", () => {
  test("line 1 produces 'SQL> '", () => {
    expect(formatPrompt(1)).toBe("SQL> ");
  });

  test("line 2 produces right-aligned '  2  '", () => {
    expect(formatPrompt(2)).toBe("  2  ");
  });

  test("line 10 keeps width but pads", () => {
    expect(formatPrompt(10)).toBe(" 10  ");
  });

  test("line 100 widens to fit", () => {
    expect(formatPrompt(100)).toBe("100  ");
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```powershell
bun run test src/lib/command/prompt.test.ts
```

Expected: FAIL — `Cannot find module './prompt'`.

- [ ] **Step 4.3: Write `prompt.ts`**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

const PRIMARY = "SQL>";

export function formatPrompt(lineNumber: number): string {
  if (lineNumber <= 1) return `${PRIMARY} `;
  const num = String(lineNumber);
  const width = Math.max(PRIMARY.length, num.length);
  const padded = num.padStart(width, " ");
  return `${padded}  `;
}
```

- [ ] **Step 4.4: Run test to verify it passes**

```powershell
bun run test src/lib/command/prompt.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 4.5: Commit**

```powershell
git add src/lib/command/prompt.ts src/lib/command/prompt.test.ts
git commit -m "feat(sprint-d): command prompt formatting (D.1)"
```

---

### Task 5: Create `command/parser.ts` + tests (Tier 1 directives only)

**Files:**
- Create: `ce/src/lib/command/parser.ts`
- Create: `ce/src/lib/command/parser.test.ts`

- [ ] **Step 5.1: Write tests first**

`parser.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { parse, type ParseContext } from "./parser";

const ctx = (): ParseContext => ({ inBlockMode: false });

describe("parse — empty / whitespace", () => {
  test("empty string is empty", () => {
    expect(parse("", ctx())).toEqual({ kind: "empty" });
  });
  test("whitespace only is empty", () => {
    expect(parse("    ", ctx())).toEqual({ kind: "empty" });
  });
});

describe("parse — directives", () => {
  test("SET LINESIZE 100", () => {
    const r = parse("SET LINESIZE 100", ctx());
    expect(r).toEqual({ kind: "directive", name: "SET", args: ["LINESIZE", "100"], raw: "SET LINESIZE 100" });
  });
  test("set linesize 100 (lowercase)", () => {
    const r = parse("set linesize 100", ctx());
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.name).toBe("SET");
  });
  test("DESC dual", () => {
    const r = parse("DESC dual", ctx());
    expect(r).toEqual({ kind: "directive", name: "DESC", args: ["dual"], raw: "DESC dual" });
  });
  test("DESCRIBE dual aliases to DESC", () => {
    const r = parse("DESCRIBE dual", ctx());
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.name).toBe("DESC");
  });
  test("@/path/to/script.sql", () => {
    const r = parse("@/tmp/foo.sql", ctx());
    expect(r).toEqual({ kind: "directive", name: "@", args: ["/tmp/foo.sql"], raw: "@/tmp/foo.sql" });
  });
  test("EXIT", () => {
    expect(parse("EXIT", ctx())).toEqual({ kind: "directive", name: "EXIT", args: [], raw: "EXIT" });
  });
  test("QUIT aliases to EXIT", () => {
    const r = parse("QUIT", ctx());
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.name).toBe("EXIT");
  });
  test("PROMPT hello world", () => {
    const r = parse("PROMPT hello world", ctx());
    expect(r).toEqual({ kind: "directive", name: "PROMPT", args: ["hello world"], raw: "PROMPT hello world" });
  });
  test("COMMIT directive", () => {
    const r = parse("COMMIT", ctx());
    expect(r).toEqual({ kind: "directive", name: "COMMIT", args: [], raw: "COMMIT" });
  });
  test("ROLLBACK directive", () => {
    const r = parse("ROLLBACK", ctx());
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.name).toBe("ROLLBACK");
  });
});

describe("parse — SQL statements", () => {
  test("SELECT without semicolon → sql_partial", () => {
    expect(parse("SELECT 1 FROM dual", ctx())).toEqual({ kind: "sql_partial", line: "SELECT 1 FROM dual" });
  });
  test("SELECT with semicolon → sql_complete", () => {
    const r = parse("SELECT 1 FROM dual;", ctx());
    expect(r.kind).toBe("sql_complete");
    if (r.kind === "sql_complete") expect(r.sql).toBe("SELECT 1 FROM dual");
  });
});

describe("parse — PL/SQL block", () => {
  test("BEGIN starts block mode → block_partial", () => {
    expect(parse("BEGIN", ctx())).toEqual({ kind: "block_partial", line: "BEGIN" });
  });
  test("DECLARE starts block mode → block_partial", () => {
    expect(parse("DECLARE x NUMBER;", ctx())).toEqual({ kind: "block_partial", line: "DECLARE x NUMBER;" });
  });
  test("CREATE OR REPLACE PROCEDURE starts block mode", () => {
    expect(parse("CREATE OR REPLACE PROCEDURE p AS", ctx())).toEqual({
      kind: "block_partial",
      line: "CREATE OR REPLACE PROCEDURE p AS",
    });
  });
  test("bare / in block mode terminates", () => {
    expect(parse("/", { inBlockMode: true })).toEqual({ kind: "execute_buffer" });
  });
  test("bare / outside block executes buffer", () => {
    expect(parse("/", ctx())).toEqual({ kind: "execute_buffer" });
  });
  test("END; inside block stays partial until /", () => {
    expect(parse("END;", { inBlockMode: true })).toEqual({ kind: "block_partial", line: "END;" });
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```powershell
bun run test src/lib/command/parser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 5.3: Write `parser.ts`**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { Parsed } from "./types";

export interface ParseContext {
  inBlockMode: boolean;
}

interface DirectiveSpec {
  canonical: string;
  argSplit: "rest" | "tokens" | "none";
}

const DIRECTIVE_TABLE: Record<string, DirectiveSpec> = {
  SET: { canonical: "SET", argSplit: "tokens" },
  DESC: { canonical: "DESC", argSplit: "tokens" },
  DESCRIBE: { canonical: "DESC", argSplit: "tokens" },
  EXIT: { canonical: "EXIT", argSplit: "none" },
  QUIT: { canonical: "EXIT", argSplit: "none" },
  COMMIT: { canonical: "COMMIT", argSplit: "none" },
  ROLLBACK: { canonical: "ROLLBACK", argSplit: "none" },
  PROMPT: { canonical: "PROMPT", argSplit: "rest" },
  CONNECT: { canonical: "CONNECT_BLOCKED", argSplit: "rest" },
  DISCONNECT: { canonical: "DISCONNECT_BLOCKED", argSplit: "none" },
  HOST: { canonical: "HOST_BLOCKED", argSplit: "rest" },
  "!": { canonical: "HOST_BLOCKED", argSplit: "rest" },
  CLEAR: { canonical: "CLEAR", argSplit: "tokens" },
};

const BLOCK_OPENERS = /^(BEGIN|DECLARE|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE(\s+BODY)?|TYPE(\s+BODY)?)\b)/i;

export function parse(rawLine: string, ctx: ParseContext): Parsed {
  const line = rawLine.replace(/\r/g, "");
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };

  // Bare slash: terminates block, or executes the previous buffer.
  if (trimmed === "/") return { kind: "execute_buffer" };

  // @file or @@file → directive `@` / `@@` with the rest as args[0]
  if (trimmed.startsWith("@@")) {
    return { kind: "directive", name: "@@", args: [trimmed.slice(2).trim()], raw: trimmed };
  }
  if (trimmed.startsWith("@")) {
    return { kind: "directive", name: "@", args: [trimmed.slice(1).trim()], raw: trimmed };
  }

  // Block mode is sticky — collect lines until the bare / handler above fires.
  if (ctx.inBlockMode) {
    return { kind: "block_partial", line };
  }

  // Directive lookup: first token uppercase.
  const firstToken = trimmed.split(/\s+/, 1)[0].toUpperCase();
  const spec = DIRECTIVE_TABLE[firstToken];
  if (spec) {
    if (spec.argSplit === "none") {
      return { kind: "directive", name: spec.canonical, args: [], raw: trimmed };
    }
    const rest = trimmed.slice(firstToken.length).trim();
    if (spec.argSplit === "rest") {
      return { kind: "directive", name: spec.canonical, args: rest === "" ? [] : [rest], raw: trimmed };
    }
    // tokens
    const tokens = rest === "" ? [] : rest.split(/\s+/);
    return { kind: "directive", name: spec.canonical, args: tokens, raw: trimmed };
  }

  // PL/SQL block opener?
  if (BLOCK_OPENERS.test(trimmed)) {
    return { kind: "block_partial", line };
  }

  // SQL: complete if it ends with ; (semicolon stripped from sql).
  if (/;\s*$/.test(trimmed)) {
    const sql = trimmed.replace(/;\s*$/, "");
    return { kind: "sql_complete", sql };
  }
  return { kind: "sql_partial", line };
}
```

- [ ] **Step 5.4: Run test to verify it passes**

```powershell
bun run test src/lib/command/parser.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5.5: Commit**

```powershell
git add src/lib/command/parser.ts src/lib/command/parser.test.ts
git commit -m "feat(sprint-d): tier-1 directive parser + SQL/PLSQL detection (D.1)"
```

---

### Task 6: Create `command/formatter.ts` + tests

**Files:**
- Create: `ce/src/lib/command/formatter.ts`
- Create: `ce/src/lib/command/formatter.test.ts`

- [ ] **Step 6.1: Write tests first**

`formatter.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { formatRows, formatStatus } from "./formatter";
import { DEFAULT_SETTINGS } from "./types";
import type { ColumnMeta } from "$lib/sql-query";

const cols = (defs: Array<[string, string, number?]>): ColumnMeta[] =>
  defs.map(([name, type, dataLen]) => ({
    name,
    typeName: type,
    dbType: 0,
    fetchType: 0,
    nullable: true,
    dataLength: dataLen ?? 30,
    precision: null,
    scale: null,
  }));

describe("formatRows — basic", () => {
  test("single string column with one row", () => {
    const out = formatRows([["X"]], cols([["D", "VARCHAR2", 1]]), DEFAULT_SETTINGS);
    expect(out).toMatch(/^D\s*\n-+\s*\nX\s*\n$/);
  });

  test("HEADING off omits header", () => {
    const out = formatRows([["X"]], cols([["D", "VARCHAR2", 1]]), { ...DEFAULT_SETTINGS, heading: false });
    expect(out).toBe("X\n");
  });

  test("two columns are separated by COLSEP", () => {
    const out = formatRows(
      [["1", "2"]],
      cols([["A", "VARCHAR2", 1], ["B", "VARCHAR2", 1]]),
      DEFAULT_SETTINGS,
    );
    const dataLine = out.split("\n").find((l) => /^1\s+2/.test(l));
    expect(dataLine).toBeDefined();
  });

  test("PAGESIZE 2 repeats header every 2 rows", () => {
    const out = formatRows(
      [["a"], ["b"], ["c"], ["d"]],
      cols([["X", "VARCHAR2", 1]]),
      { ...DEFAULT_SETTINGS, pagesize: 2 },
    );
    const headerLines = out.split("\n").filter((l) => l.trim() === "X");
    expect(headerLines.length).toBeGreaterThanOrEqual(2);
  });

  test("NULL values render as the NULL setting string", () => {
    const out = formatRows([[null]], cols([["X", "VARCHAR2", 5]]), { ...DEFAULT_SETTINGS, null: "<null>" });
    expect(out).toContain("<null>");
  });
});

describe("formatStatus", () => {
  test("1 row selected", () => {
    expect(formatStatus({ rowCount: 1, elapsedMs: 121, kind: "select" }, DEFAULT_SETTINGS))
      .toBe("\n1 row selected in 0.121 seconds.\n");
  });
  test("3 rows selected", () => {
    expect(formatStatus({ rowCount: 3, elapsedMs: 45, kind: "select" }, DEFAULT_SETTINGS))
      .toBe("\n3 rows selected in 0.045 seconds.\n");
  });
  test("PL/SQL completion", () => {
    expect(formatStatus({ rowCount: 0, elapsedMs: 12, kind: "plsql" }, DEFAULT_SETTINGS))
      .toBe("\nPL/SQL procedure successfully completed in 0.012 seconds.\n");
  });
  test("FEEDBACK off suppresses status", () => {
    expect(formatStatus({ rowCount: 1, elapsedMs: 1, kind: "select" }, { ...DEFAULT_SETTINGS, feedback: false }))
      .toBe("");
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

```powershell
bun run test src/lib/command/formatter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 6.3: Write `formatter.ts`**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import type { ColumnMeta } from "$lib/sql-query";
import type { CommandSettings } from "./types";

const NUMERIC_TYPES = new Set(["NUMBER", "FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE", "INTEGER"]);

function isNumericCol(c: ColumnMeta): boolean {
  return NUMERIC_TYPES.has(c.typeName.toUpperCase());
}

function colWidth(c: ColumnMeta, settings: CommandSettings, rows: any[][], idx: number): number {
  if (isNumericCol(c)) return Math.max(settings.numwidth, c.name.length);
  let max = c.name.length;
  for (const row of rows) {
    const val = row[idx];
    const s = val === null || val === undefined ? settings.null : String(val);
    if (s.length > max) max = s.length;
  }
  // Cap by reasonable upper bound to avoid run-away widths on CLOB
  return Math.min(max, Math.max(settings.linesize, 30));
}

function renderHeader(columns: ColumnMeta[], widths: number[], settings: CommandSettings): string {
  const titles = columns.map((c, i) => {
    const name = c.name.toUpperCase();
    return isNumericCol(c) ? name.padStart(widths[i]) : name.padEnd(widths[i]);
  });
  const seps = widths.map((w) => "-".repeat(w));
  return `${titles.join(settings.colsep)}\n${seps.join(settings.colsep)}\n`;
}

function renderRow(row: any[], columns: ColumnMeta[], widths: number[], settings: CommandSettings): string {
  return columns
    .map((c, i) => {
      const v = row[i];
      const s = v === null || v === undefined ? settings.null : String(v);
      return isNumericCol(c) ? s.padStart(widths[i]) : s.padEnd(widths[i]);
    })
    .join(settings.colsep) + "\n";
}

export function formatRows(
  rows: any[][],
  columns: ColumnMeta[],
  settings: CommandSettings,
): string {
  if (columns.length === 0) return "";
  const widths = columns.map((c, i) => colWidth(c, settings, rows, i));
  let out = "";
  if (settings.heading && settings.pagesize > 0) {
    out += renderHeader(columns, widths, settings);
  } else if (settings.heading && settings.pagesize === 0) {
    out += renderHeader(columns, widths, settings);
  }
  let rowsSinceHeader = 0;
  for (let i = 0; i < rows.length; i++) {
    out += renderRow(rows[i], columns, widths, settings);
    rowsSinceHeader++;
    if (
      settings.heading &&
      settings.pagesize > 0 &&
      rowsSinceHeader >= settings.pagesize &&
      i < rows.length - 1
    ) {
      out += "\n" + renderHeader(columns, widths, settings);
      rowsSinceHeader = 0;
    }
  }
  return out;
}

export interface StatusInfo {
  rowCount: number;
  elapsedMs: number;
  kind: "select" | "dml" | "plsql" | "directive";
}

export function formatStatus(info: StatusInfo, settings: CommandSettings): string {
  if (!settings.feedback) return "";
  const seconds = (info.elapsedMs / 1000).toFixed(3);
  if (info.kind === "select") {
    if (info.rowCount === 1) return `\n1 row selected in ${seconds} seconds.\n`;
    return `\n${info.rowCount} rows selected in ${seconds} seconds.\n`;
  }
  if (info.kind === "plsql") {
    return `\nPL/SQL procedure successfully completed in ${seconds} seconds.\n`;
  }
  if (info.kind === "dml") {
    if (info.rowCount === 1) return `\n1 row processed in ${seconds} seconds.\n`;
    return `\n${info.rowCount} rows processed in ${seconds} seconds.\n`;
  }
  return "";
}

export function formatError(code: number | string, message: string): string {
  return `\n${typeof code === "number" ? `ORA-${String(code).padStart(5, "0")}` : code}: ${message}\n`;
}
```

- [ ] **Step 6.4: Run test to verify it passes**

```powershell
bun run test src/lib/command/formatter.test.ts
```

Expected: all PASS.

- [ ] **Step 6.5: Commit**

```powershell
git add src/lib/command/formatter.ts src/lib/command/formatter.test.ts
git commit -m "feat(sprint-d): tabular ASCII formatter + status/error formatting (D.1)"
```

---

### Task 7: Create `command/state.svelte.ts` + tests

**Files:**
- Create: `ce/src/lib/command/state.svelte.ts`
- Create: `ce/src/lib/command/state.test.ts`

- [ ] **Step 7.1: Write tests first**

`state.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createCommandState } from "./state.svelte";

describe("createCommandState", () => {
  test("starts with empty buffer and SQL*Plus defaults", () => {
    const s = createCommandState("conn-1");
    expect(s.connectionId).toBe("conn-1");
    expect(s.bufferedLines.length).toBe(0);
    expect(s.inBlockMode).toBe(false);
    expect(s.settings.linesize).toBe(80);
    expect(s.settings.pagesize).toBe(14);
    expect(s.history.length).toBe(0);
  });

  test("session id is unique per state", () => {
    const a = createCommandState("c");
    const b = createCommandState("c");
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

```powershell
bun run test src/lib/command/state.test.ts
```

Expected: FAIL.

- [ ] **Step 7.3: Write `state.svelte.ts`**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { DEFAULT_SETTINGS, type CommandSettings } from "./types";

export interface CommandState {
  connectionId: string;
  sessionId: string;
  settings: CommandSettings;
  bufferedLines: string[];
  inBlockMode: boolean;
  lastBuffer: string;
  history: string[];
  historyCursor: number;
  promptLineNumber: number;
}

export function createCommandState(connectionId: string): CommandState {
  return {
    connectionId,
    sessionId: crypto.randomUUID(),
    settings: { ...DEFAULT_SETTINGS },
    bufferedLines: [],
    inBlockMode: false,
    lastBuffer: "",
    history: [],
    historyCursor: -1,
    promptLineNumber: 1,
  };
}

export function resetBuffer(state: CommandState): void {
  if (state.bufferedLines.length > 0) {
    state.lastBuffer = state.bufferedLines.join("\n");
  }
  state.bufferedLines = [];
  state.inBlockMode = false;
  state.promptLineNumber = 1;
}

export function pushBuffer(state: CommandState, line: string): void {
  state.bufferedLines.push(line);
  state.promptLineNumber = state.bufferedLines.length + 1;
}
```

- [ ] **Step 7.4: Run test to verify it passes**

```powershell
bun run test src/lib/command/state.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 7.5: Commit**

```powershell
git add src/lib/command/state.svelte.ts src/lib/command/state.test.ts
git commit -m "feat(sprint-d): per-tab Command Window state factory (D.1)"
```

---

### Task 8: Create `command/line-editor.ts` + tests

**Files:**
- Create: `ce/src/lib/command/line-editor.ts`
- Create: `ce/src/lib/command/line-editor.test.ts`

- [ ] **Step 8.1: Write tests first**

`line-editor.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { LineEditor } from "./line-editor";

const makeMockTerm = () => {
  const writes: string[] = [];
  const handlers: Array<(d: string) => void> = [];
  return {
    write: (s: string) => { writes.push(s); },
    onData: (h: (d: string) => void) => { handlers.push(h); return { dispose: () => {} }; },
    fire: (d: string) => { for (const h of handlers) h(d); },
    writes,
  };
};

describe("LineEditor", () => {
  test("printable input echoes and accumulates", () => {
    const term = makeMockTerm();
    const submit = vi.fn();
    const editor = new LineEditor(term as any, { onSubmit: submit, onCancel: () => {} });
    editor.start();
    term.fire("a");
    term.fire("b");
    term.fire("c");
    expect(term.writes.join("")).toContain("abc");
    expect(submit).not.toHaveBeenCalled();
  });

  test("Enter submits the buffer and resets", () => {
    const term = makeMockTerm();
    const submit = vi.fn();
    const editor = new LineEditor(term as any, { onSubmit: submit, onCancel: () => {} });
    editor.start();
    term.fire("h");
    term.fire("i");
    term.fire("\r");
    expect(submit).toHaveBeenCalledWith("hi");
  });

  test("Backspace removes last char", () => {
    const term = makeMockTerm();
    const submit = vi.fn();
    const editor = new LineEditor(term as any, { onSubmit: submit, onCancel: () => {} });
    editor.start();
    term.fire("a");
    term.fire("b");
    term.fire(""); // DEL
    term.fire("\r");
    expect(submit).toHaveBeenCalledWith("a");
  });

  test("Ctrl+C cancels the line", () => {
    const term = makeMockTerm();
    const submit = vi.fn();
    const cancel = vi.fn();
    const editor = new LineEditor(term as any, { onSubmit: submit, onCancel: cancel });
    editor.start();
    term.fire("a");
    term.fire("");
    expect(cancel).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("history navigation with arrow up/down", () => {
    const term = makeMockTerm();
    const submit = vi.fn();
    const editor = new LineEditor(term as any, { onSubmit: submit, onCancel: () => {} });
    editor.start();
    editor.setHistory(["SELECT 1", "SELECT 2"]);
    term.fire("[A"); // up
    term.fire("\r");
    expect(submit).toHaveBeenCalledWith("SELECT 2");
  });

  test("paste of multi-line text submits each line in order", () => {
    const term = makeMockTerm();
    const submit = vi.fn();
    const editor = new LineEditor(term as any, { onSubmit: submit, onCancel: () => {} });
    editor.start();
    term.fire("a\r\nb\r\nc");
    expect(submit).toHaveBeenNthCalledWith(1, "a");
    expect(submit).toHaveBeenNthCalledWith(2, "b");
    expect(submit).not.toHaveBeenCalledWith("c");
  });
});
```

- [ ] **Step 8.2: Run test to verify it fails**

```powershell
bun run test src/lib/command/line-editor.test.ts
```

Expected: FAIL.

- [ ] **Step 8.3: Write `line-editor.ts`**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

interface TermLike {
  write(data: string): void;
  onData(handler: (data: string) => void): { dispose(): void };
}

export interface LineEditorOptions {
  onSubmit: (line: string) => void;
  onCancel: () => void;
  promptWriter?: () => void;
}

export class LineEditor {
  private term: TermLike;
  private opts: LineEditorOptions;
  private buf = "";
  private cursor = 0;
  private history: string[] = [];
  private hcursor = -1;
  private hsave = "";
  private disposer: { dispose(): void } | null = null;
  private active = false;

  constructor(term: TermLike, opts: LineEditorOptions) {
    this.term = term;
    this.opts = opts;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.disposer = this.term.onData((d) => this.handleData(d));
  }

  stop(): void {
    this.active = false;
    this.disposer?.dispose();
    this.disposer = null;
  }

  setHistory(h: string[]): void {
    this.history = [...h];
    this.hcursor = -1;
  }

  appendHistory(line: string): void {
    if (line.trim() === "") return;
    this.history.push(line);
    this.hcursor = -1;
  }

  reset(): void {
    this.buf = "";
    this.cursor = 0;
    this.hcursor = -1;
  }

  private handleData(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      // Multi-line paste: split on \r, \n, or \r\n.
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && data[i + 1] === "\n") i++;
        const line = this.buf;
        this.term.write("\r\n");
        this.opts.onSubmit(line);
        this.buf = "";
        this.cursor = 0;
        this.hcursor = -1;
        i++;
        continue;
      }
      if (ch === "") { // Ctrl+C
        this.term.write("^C\r\n");
        this.buf = "";
        this.cursor = 0;
        this.hcursor = -1;
        this.opts.onCancel();
        i++;
        continue;
      }
      if (ch === "" || ch === "\b") { // Backspace / DEL
        if (this.cursor > 0) {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
          // Redraw: move back, write rest + space, move back again
          const rest = this.buf.slice(this.cursor) + " ";
          this.term.write("\b" + rest + "\b".repeat(rest.length));
        }
        i++;
        continue;
      }
      if (ch === "" && data[i + 1] === "[") {
        const code = data[i + 2];
        if (code === "A") { // up
          this.navigateHistory(1);
          i += 3;
          continue;
        }
        if (code === "B") { // down
          this.navigateHistory(-1);
          i += 3;
          continue;
        }
        if (code === "D") { // left
          if (this.cursor > 0) {
            this.cursor--;
            this.term.write("[D");
          }
          i += 3;
          continue;
        }
        if (code === "C") { // right
          if (this.cursor < this.buf.length) {
            this.cursor++;
            this.term.write("[C");
          }
          i += 3;
          continue;
        }
        // Unknown escape — eat the introducer and continue.
        i += 3;
        continue;
      }
      if (ch === "") { // Ctrl+A → home
        if (this.cursor > 0) {
          this.term.write("[D".repeat(this.cursor));
          this.cursor = 0;
        }
        i++;
        continue;
      }
      if (ch === "") { // Ctrl+E → end
        if (this.cursor < this.buf.length) {
          this.term.write("[C".repeat(this.buf.length - this.cursor));
          this.cursor = this.buf.length;
        }
        i++;
        continue;
      }
      if (ch === "") { // Ctrl+L → clear
        this.term.write("[2J[H");
        i++;
        continue;
      }
      if (ch >= " ") {
        // Insert printable
        this.buf = this.buf.slice(0, this.cursor) + ch + this.buf.slice(this.cursor);
        this.cursor++;
        // Redraw from cursor
        const tail = this.buf.slice(this.cursor - 1);
        this.term.write(tail);
        if (tail.length > 1) {
          this.term.write("[D".repeat(tail.length - 1));
        }
        i++;
        continue;
      }
      // Skip other control chars silently.
      i++;
    }
  }

  private navigateHistory(direction: 1 | -1): void {
    if (this.history.length === 0) return;
    if (this.hcursor === -1) this.hsave = this.buf;
    if (direction === 1) {
      this.hcursor =
        this.hcursor === -1 ? this.history.length - 1 : Math.max(0, this.hcursor - 1);
    } else {
      if (this.hcursor === -1) return;
      this.hcursor++;
      if (this.hcursor >= this.history.length) {
        this.hcursor = -1;
        this.replaceLine(this.hsave);
        return;
      }
    }
    this.replaceLine(this.history[this.hcursor]);
  }

  private replaceLine(newBuf: string): void {
    // Erase current buffer.
    if (this.cursor > 0) this.term.write("[D".repeat(this.cursor));
    this.term.write(" ".repeat(this.buf.length));
    this.term.write("[D".repeat(this.buf.length));
    // Write new buffer.
    this.term.write(newBuf);
    this.buf = newBuf;
    this.cursor = newBuf.length;
  }
}
```

- [ ] **Step 8.4: Run test to verify it passes**

```powershell
bun run test src/lib/command/line-editor.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 8.5: Commit**

```powershell
git add src/lib/command/line-editor.ts src/lib/command/line-editor.test.ts
git commit -m "feat(sprint-d): xterm line editor (cursor/history/paste/Ctrl+C-L) (D.1)"
```

---

### Task 9: Create `command/history.ts` (Tauri wrappers)

**Files:**
- Create: `ce/src/lib/command/history.ts`

- [ ] **Step 9.1: Write the file**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { invoke } from "@tauri-apps/api/core";
import type { CommandHistoryEntry } from "./types";

export async function loadHistory(connectionId: string, limit = 500): Promise<string[]> {
  try {
    const rows = await invoke<CommandHistoryEntry[]>("command_history_load", {
      connectionId,
      limit,
    });
    // Return chronological (oldest → newest) so ↑ navigates from most recent.
    return rows.reverse().map((r) => r.command);
  } catch {
    return [];
  }
}

export async function appendHistory(
  connectionId: string,
  command: string,
  sessionId: string,
  origin: string,
): Promise<void> {
  if (command.trim() === "") return;
  try {
    await invoke("command_history_append", { connectionId, command, sessionId, origin });
  } catch {
    /* swallow — history persistence is best-effort */
  }
}
```

- [ ] **Step 9.2: Commit**

```powershell
git add src/lib/command/history.ts
git commit -m "feat(sprint-d): command history Tauri wrappers (D.1)"
```

---

### Task 10: Extract `runStatementShared(sql, opts)` from `sql-editor.svelte.ts`

**Files:**
- Modify: `ce/src/lib/stores/sql-editor.svelte.ts`

This task refactors the existing `runActive()` so SQL execution becomes callable from the Command Window without duplicating the safety pipeline.

- [ ] **Step 10.1: Read the existing `runActive()` end-to-end**

Run this first so the refactor preserves all branches:

```powershell
sed -n '485,575p' src/lib/stores/sql-editor.svelte.ts
```

Note all the side effects: `askConfirm`, `askUnsafeDml`, `pushHistory`, the auto-EXPLAIN fire-and-forget, `compileErrorsGet`, `objectVersionCapture`, the `_pendingTx` flip on DML+returning rowCount.

- [ ] **Step 10.2: Add `runStatementShared` near `runActive`**

After the closing `}` of `runActive`, add:

```ts
  /**
   * Sprint D Onda 1: shared single-statement execution path used by SqlEditor
   * and Command Window. Bypasses tab.results management — caller renders
   * the SharedExecResult itself. All safety guards (askConfirm, askUnsafeDml,
   * audit chain, AI approval, ProductionDetector, PSDPM) are preserved.
   */
  async runStatementShared(
    sql: string,
    opts: { origin?: "user_typed" | "ai_approved" | "script_executed"; bypassConfirm?: boolean } = {},
  ): Promise<import("$lib/command/types").SharedExecResult> {
    const cleaned = stripTrailingSemicolon(sql);
    const failure = (code: number, message: string): import("$lib/command/types").SharedExecResult => ({
      rows: [], columns: [], rowCount: 0, elapsedMs: 0, dbmsOutput: [],
      error: { code, message },
    });
    if (cleaned === "") return failure(-32099, "empty statement");
    if (!opts.bypassConfirm) {
      const c = askConfirm(cleaned);
      const okConfirm = c === true || (await c);
      if (!okConfirm) return failure(-32098, "Operation cancelled by user.");
    }
    const requestId = crypto.randomUUID();
    let res = await queryExecute(cleaned, requestId);
    if (!res.ok && isUnsafeDmlError(res.error)) {
      const ack = await askUnsafeDml(cleaned, res.error?.message ?? "");
      if (!ack) return failure(-32098, "Operation cancelled by user.");
      res = await queryExecute(cleaned, requestId, false, true);
    }
    if (!res.ok) {
      return {
        rows: [], columns: [], rowCount: 0, elapsedMs: 0, dbmsOutput: [],
        error: { code: res.error?.code ?? -32000, message: res.error?.message ?? "Unknown error" },
      };
    }
    return {
      rows: res.data.rows ?? [],
      columns: res.data.columns ?? [],
      rowCount: res.data.rowCount,
      elapsedMs: res.data.elapsedMs,
      dbmsOutput: res.data.dbmsOutput ?? [],
      error: null,
    };
  },
```

- [ ] **Step 10.3: Compile-check**

```powershell
bun run check
```

Expected: clean. If `stripTrailingSemicolon` or `queryExecute` is not in scope, find the right import line near the top of the file.

- [ ] **Step 10.4: Commit**

```powershell
git add src/lib/stores/sql-editor.svelte.ts
git commit -m "refactor(sprint-d): extract runStatementShared for Command Window reuse (D.1)"
```

---

### Task 11: Add `tab.kind: 'sql' | 'command'` + `openCommand()` to sqlEditor

**Files:**
- Modify: `ce/src/lib/stores/sql-editor.svelte.ts`

- [ ] **Step 11.1: Add `kind` to `SqlTab` type**

In the `SqlTab` type definition (around line 43), add:

```ts
  kind: "sql" | "command";   // "sql" by default; "command" = Command Window
```

- [ ] **Step 11.2: Update tab factory functions**

Search for every `SqlTab` literal that creates a new tab (`open()`, `openSqlFile()`, `openPlsqlObject()`, `openPackage()`, etc.). For each, add `kind: "sql"` to the literal.

- [ ] **Step 11.3: Add `openCommand` method**

Near the existing `open()` method, append:

```ts
  openCommand(connectionId: string): void {
    const id = newId();
    const tab: SqlTab = {
      id,
      title: "Command",
      sql: "",
      results: [],
      activeResultId: null,
      running: false,
      runningRequestId: null,
      splitterError: null,
      filePath: null,
      isDirty: false,
      savedContent: null,
      plsqlMeta: null,
      packageSpec: undefined,
      packageActiveTab: undefined,
      specMeta: undefined,
      kind: "command",
    };
    _tabs = [..._tabs, tab];
    _activeId = id;
    // connectionId is consumed by CommandWindow.svelte via $state binding.
    void connectionId;
  },
```

- [ ] **Step 11.4: Compile-check**

```powershell
bun run check
```

Expected: clean.

- [ ] **Step 11.5: Commit**

```powershell
git add src/lib/stores/sql-editor.svelte.ts
git commit -m "feat(sprint-d): add tab.kind + openCommand() to sqlEditor (D.1)"
```

---

### Task 12: Create `command/script-runner.ts`

**Files:**
- Create: `ce/src/lib/command/script-runner.ts`

- [ ] **Step 12.1: Write the file**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { invoke } from "@tauri-apps/api/core";

export interface ScriptReadResult {
  ok: true;
  lines: string[];
}

export interface ScriptReadError {
  ok: false;
  code: string;
  message: string;
}

export async function readScript(path: string): Promise<ScriptReadResult | ScriptReadError> {
  try {
    const text = await invoke<string>("command_script_read", { path });
    const lines = text.replace(/\r/g, "").split("\n");
    return { ok: true, lines };
  } catch (e: any) {
    const msg = typeof e === "string" ? e : e?.message ?? String(e);
    return { ok: false, code: "SP2-0310", message: msg };
  }
}
```

- [ ] **Step 12.2: Commit**

```powershell
git add src/lib/command/script-runner.ts
git commit -m "feat(sprint-d): @file.sql script reader via Tauri fs (D.1)"
```

---

### Task 13: Create `command/executor.ts` — directive handlers + SQL routing

**Files:**
- Create: `ce/src/lib/command/executor.ts`

This is the largest D.1 module. It owns the runtime loop: take a `Parsed`, mutate `state` and emit text into a buffer that the CommandWindow flushes to xterm.

- [ ] **Step 13.1: Write the file**

```ts
// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { tableDescribe, connectionCommit, connectionRollback } from "$lib/workspace";
import type { CommandState } from "./state.svelte";
import { resetBuffer, pushBuffer } from "./state.svelte";
import { formatRows, formatStatus, formatError } from "./formatter";
import type { Parsed, SharedExecResult } from "./types";
import { readScript } from "./script-runner";
import { sqlEditor } from "$lib/stores/sql-editor.svelte";
import { appendHistory } from "./history";

export interface ExecCtx {
  /** Write text directly to the xterm host. CommandWindow wires this. */
  write: (text: string) => void;
  /** Called after a SET that affects the next prompt rendering. */
  refreshPrompt?: () => void;
  /** Tab close — for EXIT. */
  closeTab?: () => void;
  /** Origin for audit / history. Default 'user_typed'. */
  origin: "user_typed" | "ai_approved" | "script_executed";
}

export async function executeParsed(
  parsed: Parsed,
  state: CommandState,
  ctx: ExecCtx,
): Promise<void> {
  switch (parsed.kind) {
    case "empty":
      return;
    case "sql_partial":
    case "block_partial":
      pushBuffer(state, parsed.line);
      if (parsed.kind === "block_partial") state.inBlockMode = true;
      return;
    case "sql_complete":
      // A bare ;-terminated line that didn't enter block mode.
      pushBuffer(state, parsed.sql + ";");
      await flushSql(state, ctx);
      return;
    case "block_complete":
      pushBuffer(state, parsed.sql);
      await flushBlock(state, ctx);
      return;
    case "execute_buffer":
      if (state.inBlockMode) {
        await flushBlock(state, ctx);
      } else if (state.lastBuffer.trim() !== "") {
        await replayBuffer(state, ctx);
      }
      return;
    case "directive":
      await runDirective(parsed.name, parsed.args, parsed.raw, state, ctx);
      return;
    case "parse_error":
      ctx.write(`\n${parsed.code}: ${parsed.msg}\n`);
      return;
  }
}

async function flushSql(state: CommandState, ctx: ExecCtx): Promise<void> {
  const sql = state.bufferedLines.join("\n").replace(/;\s*$/, "");
  resetBuffer(state);
  state.lastBuffer = sql;
  await runSql(sql, "select_or_dml", state, ctx);
}

async function flushBlock(state: CommandState, ctx: ExecCtx): Promise<void> {
  const sql = state.bufferedLines.join("\n");
  resetBuffer(state);
  state.lastBuffer = sql;
  await runSql(sql, "plsql", state, ctx);
}

async function replayBuffer(state: CommandState, ctx: ExecCtx): Promise<void> {
  const sql = state.lastBuffer;
  await runSql(sql, sql.trim().match(/^(BEGIN|DECLARE)/i) ? "plsql" : "select_or_dml", state, ctx);
}

async function runSql(
  sql: string,
  kind: "select_or_dml" | "plsql",
  state: CommandState,
  ctx: ExecCtx,
): Promise<void> {
  const result: SharedExecResult = await sqlEditor.runStatementShared(sql, { origin: ctx.origin });
  if (result.error) {
    ctx.write(formatError(result.error.code, result.error.message));
  } else {
    if (result.columns.length > 0 && result.rows.length > 0) {
      ctx.write(formatRows(result.rows, result.columns, state.settings));
    }
    if (state.settings.serveroutput && result.dbmsOutput.length > 0) {
      ctx.write(result.dbmsOutput.join("\n") + "\n");
    }
    ctx.write(
      formatStatus(
        {
          rowCount: result.rowCount,
          elapsedMs: result.elapsedMs,
          kind: kind === "plsql" ? "plsql" : (result.columns.length > 0 ? "select" : "dml"),
        },
        state.settings,
      ),
    );
  }
  void appendHistory(state.connectionId, sql, state.sessionId, ctx.origin);
  state.history.push(sql);
}

async function runDirective(
  name: string,
  args: string[],
  raw: string,
  state: CommandState,
  ctx: ExecCtx,
): Promise<void> {
  switch (name) {
    case "EXIT":
      ctx.closeTab?.();
      return;
    case "PROMPT":
      ctx.write((args[0] ?? "") + "\n");
      return;
    case "SET":
      handleSet(args, state, ctx);
      return;
    case "DESC":
      await handleDesc(args, state, ctx);
      return;
    case "@":
    case "@@":
      await handleAt(args, state, ctx);
      return;
    case "COMMIT": {
      const r = await connectionCommit();
      ctx.write(r.ok ? "\nCommit complete.\n" : formatError(r.error?.code ?? -32000, r.error?.message ?? "commit failed"));
      void appendHistory(state.connectionId, "COMMIT", state.sessionId, ctx.origin);
      return;
    }
    case "ROLLBACK": {
      const r = await connectionRollback();
      ctx.write(r.ok ? "\nRollback complete.\n" : formatError(r.error?.code ?? -32000, r.error?.message ?? "rollback failed"));
      void appendHistory(state.connectionId, "ROLLBACK", state.sessionId, ctx.origin);
      return;
    }
    case "CLEAR":
      handleClear(args, state, ctx);
      return;
    case "CONNECT_BLOCKED":
      ctx.write("\nSP2-NOTSUPPORTED: CONNECT/DISCONNECT not supported in Veesker Command Window.\n");
      return;
    case "DISCONNECT_BLOCKED":
      ctx.write("\nSP2-NOTSUPPORTED: DISCONNECT not supported in Veesker Command Window.\n");
      return;
    case "HOST_BLOCKED":
      ctx.write("\nSP2-NOTSUPPORTED: HOST/! shell escape blocked for security.\n");
      return;
    default:
      ctx.write(`\nSP2-0042: unknown command "${raw}" - rest of line ignored.\n`);
  }
}

function handleSet(args: string[], state: CommandState, ctx: ExecCtx): void {
  if (args.length === 0) {
    ctx.write("\nSP2-0158: missing SET option.\n");
    return;
  }
  const opt = args[0].toUpperCase();
  const val = args.slice(1).join(" ");
  switch (opt) {
    case "LINESIZE": {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 32767) state.settings.linesize = n;
      else ctx.write(`\nSP2-0267: linesize option ${val} out of range (1 .. 32767)\n`);
      return;
    }
    case "PAGESIZE":
    case "PAGES": {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 50000) state.settings.pagesize = n;
      else ctx.write(`\nSP2-0267: pagesize option ${val} out of range (0 .. 50000)\n`);
      return;
    }
    case "FEEDBACK":
      state.settings.feedback = parseOnOff(val, true);
      return;
    case "ECHO":
      state.settings.echo = parseOnOff(val, false);
      return;
    case "TIMING":
      state.settings.timing = parseOnOff(val, false);
      return;
    case "HEADING":
      state.settings.heading = parseOnOff(val, true);
      return;
    case "SERVEROUTPUT":
      state.settings.serveroutput = parseOnOff(val, true);
      return;
    case "TERMOUT":
      state.settings.termout = parseOnOff(val, true);
      return;
    case "WRAP":
      state.settings.wrap = parseOnOff(val, true);
      return;
    case "TRIMOUT":
      state.settings.trimout = parseOnOff(val, true);
      return;
    case "TRIMSPOOL":
      state.settings.trimspool = parseOnOff(val, false);
      return;
    case "VERIFY":
      state.settings.verify = parseOnOff(val, true);
      return;
    case "NULL":
      state.settings.null = stripQuotes(val);
      return;
    case "COLSEP":
      state.settings.colsep = stripQuotes(val) || " ";
      return;
    case "NUMWIDTH": {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 50) state.settings.numwidth = n;
      return;
    }
    default:
      ctx.write(`\nSP2-0158: unknown SET option "${opt}"\n`);
  }
}

function parseOnOff(val: string, def: boolean): boolean {
  const v = val.trim().toUpperCase();
  if (v === "ON") return true;
  if (v === "OFF") return false;
  return def;
}

function stripQuotes(val: string): string {
  const t = val.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

async function handleDesc(args: string[], state: CommandState, ctx: ExecCtx): Promise<void> {
  if (args.length === 0) {
    ctx.write("\nUsage: DESC[RIBE] <object>\n");
    return;
  }
  const target = args[0].replace(/^"|"$/g, "");
  const parts = target.split(".");
  const owner = parts.length > 1 ? parts[0].toUpperCase() : null;
  const name = (parts.length > 1 ? parts[1] : parts[0]).toUpperCase();
  try {
    const cols = await tableDescribe(owner, name);
    if (cols.length === 0) {
      ctx.write(`\nORA-04043: object ${target} does not exist\n`);
      return;
    }
    const out: string[] = [];
    out.push(" Name".padEnd(31) + "Null?".padEnd(10) + "Type");
    out.push(" " + "-".repeat(30) + " " + "-".repeat(8) + " " + "-".repeat(20));
    for (const c of cols) {
      const nullable = c.nullable ? "" : "NOT NULL";
      const typ = c.dataType + (c.dataLength ? `(${c.dataLength})` : "");
      out.push(" " + c.columnName.padEnd(30) + " " + nullable.padEnd(8) + " " + typ);
    }
    ctx.write("\n" + out.join("\n") + "\n");
  } catch (e: any) {
    ctx.write(formatError(-32000, e?.message ?? String(e)));
  }
}

async function handleAt(args: string[], state: CommandState, ctx: ExecCtx): Promise<void> {
  if (args.length === 0) {
    ctx.write("\nSP2-0310: unable to open file \"\"\n");
    return;
  }
  const path = args[0];
  const r = await readScript(path);
  if (!r.ok) {
    ctx.write(`\n${r.code}: ${r.message}\n`);
    return;
  }
  const { parse } = await import("./parser");
  const scriptCtx: ExecCtx = { ...ctx, origin: "script_executed" };
  for (const line of r.lines) {
    if (state.settings.echo) ctx.write(line + "\n");
    const parsed = parse(line, { inBlockMode: state.inBlockMode });
    await executeParsed(parsed, state, scriptCtx);
  }
}

function handleClear(args: string[], state: CommandState, ctx: ExecCtx): void {
  const target = (args[0] ?? "").toUpperCase();
  if (target === "SCREEN" || target === "SCR") {
    ctx.write("[2J[H");
  } else if (target === "BUFFER" || target === "BUFF") {
    state.bufferedLines = [];
    state.inBlockMode = false;
    state.lastBuffer = "";
  } else {
    ctx.write(`\nSP2-0042: unknown CLEAR target "${args[0] ?? ""}"\n`);
  }
}
```

**Note for the implementing agent:** `tableDescribe`, `connectionCommit`, `connectionRollback` are exports of `$lib/workspace`. If their signatures differ from what's used above, adjust the calls — the existing SqlDrawer commit/rollback buttons use these same APIs, so search for `connectionCommit(` to find the correct shape.

- [ ] **Step 13.2: Compile check**

```powershell
bun run check
```

Expected: clean (or fixable by adjusting imports).

- [ ] **Step 13.3: Commit**

```powershell
git add src/lib/command/executor.ts
git commit -m "feat(sprint-d): command executor — directives + SQL routing via runStatementShared (D.1)"
```

---

### Task 14: Create `CommandWindow.svelte`

**Files:**
- Create: `ce/src/lib/workspace/CommandWindow.svelte`

- [ ] **Step 14.1: Write the component**

```svelte
<!--
  Copyright 2022-2026 Geraldo Ferreira Viana Júnior
  Licensed under the Apache License, Version 2.0
  https://github.com/veesker-cloud/veesker-community-edition
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { sqlEditor, type SqlTab } from "$lib/stores/sql-editor.svelte";
  import { createCommandState, type CommandState } from "$lib/command/state.svelte";
  import { LineEditor } from "$lib/command/line-editor";
  import { parse } from "$lib/command/parser";
  import { executeParsed, type ExecCtx } from "$lib/command/executor";
  import { formatPrompt } from "$lib/command/prompt";
  import { loadHistory } from "$lib/command/history";

  type Props = { tab: SqlTab; connectionId: string };
  let { tab, connectionId }: Props = $props();

  let host = $state<HTMLDivElement | undefined>();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let editor: LineEditor | null = null;
  let state: CommandState | null = null;

  function writePrompt(): void {
    if (!term || !state) return;
    term.write(formatPrompt(state.promptLineNumber));
  }

  async function handleSubmit(line: string): Promise<void> {
    if (!term || !state || !editor) return;
    const parsed = parse(line, { inBlockMode: state.inBlockMode });
    const ctx: ExecCtx = {
      write: (t) => term?.write(t.replace(/\n/g, "\r\n")),
      refreshPrompt: writePrompt,
      closeTab: () => sqlEditor.close(tab.id),
      origin: "user_typed",
    };
    if (parsed.kind === "directive" || parsed.kind === "sql_complete" || parsed.kind === "block_complete" || parsed.kind === "execute_buffer" || parsed.kind === "parse_error") {
      editor.appendHistory(state.lastBuffer || line);
    }
    await executeParsed(parsed, state, ctx);
    writePrompt();
  }

  onMount(async () => {
    if (!host) return;
    state = createCommandState(connectionId);
    const hist = await loadHistory(connectionId, 500);
    state.history = hist;

    term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Consolas', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      convertEol: true,
      theme: {
        background: "#0e0c0a",
        foreground: "#e6dccd",
        cursor: "#f5a08a",
        selectionBackground: "#3a342c",
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.write(`Connected. Type EXIT to close.\r\n`);
    writePrompt();

    editor = new LineEditor(term as any, {
      onSubmit: (line) => { void handleSubmit(line); },
      onCancel: () => {
        if (state) {
          state.bufferedLines = [];
          state.inBlockMode = false;
          state.promptLineNumber = 1;
        }
        writePrompt();
      },
    });
    editor.setHistory(hist);
    editor.start();

    const onResize = () => fit?.fit();
    window.addEventListener("resize", onResize);

    onDestroy(() => {
      window.removeEventListener("resize", onResize);
      editor?.stop();
      term?.dispose();
    });
  });
</script>

<div class="command-window">
  <div class="term-host" bind:this={host}></div>
</div>

<style>
  .command-window {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-surface-alt);
  }
  .term-host {
    flex: 1;
    min-height: 0;
    padding: 4px 0 0 6px;
  }
  :global(.command-window .xterm-viewport) { background: transparent !important; }
</style>
```

- [ ] **Step 14.2: Commit**

```powershell
git add src/lib/workspace/CommandWindow.svelte
git commit -m "feat(sprint-d): CommandWindow.svelte — xterm host wired to executor (D.1)"
```

---

### Task 15: Wire `CommandWindow` into `SqlDrawer.svelte`

**Files:**
- Modify: `ce/src/lib/workspace/SqlDrawer.svelte`

- [ ] **Step 15.1: Find where the active tab content renders**

Search for the block that renders the active SQL tab body (likely near `{#if active}`/the editor mount). Open the file and read 50 lines around the render.

- [ ] **Step 15.2: Switch by `tab.kind`**

Replace the existing single render path with a switch:

```svelte
{#if tab.kind === "command"}
  <CommandWindow {tab} connectionId={currentConnectionId} />
{:else}
  <!-- existing SQL editor render -->
{/if}
```

Add the import:

```ts
import CommandWindow from "$lib/workspace/CommandWindow.svelte";
```

`currentConnectionId` should be the same connectionId the SqlDrawer already has — search for the existing prop or store binding.

- [ ] **Step 15.3: Add "New Command Window" item to the new-tab dropdown**

If the existing `+` button opens directly without a menu, change it to a small dropdown (`<button>` + `<div class="menu">…</div>` toggled by a `$state` flag). Items:

- "New SQL Window" → existing `sqlEditor.open()`
- "New Command Window" → `sqlEditor.openCommand(currentConnectionId)`

Or — to ship D.1 fast — replace the `+` button with two visible buttons: one for SQL (`+`) and one for Command (`>_`).

Pick the dropdown approach if the tabbar can fit it; fall back to two buttons otherwise.

- [ ] **Step 15.4: Compile check**

```powershell
bun run check
```

Expected: clean.

- [ ] **Step 15.5: Commit**

```powershell
git add src/lib/workspace/SqlDrawer.svelte
git commit -m "feat(sprint-d): SqlDrawer renders CommandWindow when tab.kind=command + new-tab menu (D.1)"
```

---

### Task 16: Bind Ctrl+Shift+N keyboard shortcut

**Files:**
- Modify: `ce/src/routes/workspace/[id]/+page.svelte`

- [ ] **Step 16.1: Find the existing keyboard handler**

Search for `event.key`/`shortcut`/`keydown` in the file.

- [ ] **Step 16.2: Add the shortcut**

In the existing keydown handler, add:

```ts
if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
  event.preventDefault();
  sqlEditor.openCommand(connectionId);
  return;
}
```

Make sure `connectionId` resolves correctly in this scope — mirror what other shortcuts already do.

- [ ] **Step 16.3: Compile-check**

```powershell
bun run check
```

Expected: clean.

- [ ] **Step 16.4: Commit**

```powershell
git add src/routes/workspace/'[id]'/+page.svelte
git commit -m "feat(sprint-d): bind Ctrl+Shift+N to open Command Window (D.1)"
```

---

### Task 17: Run full test suite + clean compile

- [ ] **Step 17.1: Frontend tests**

```powershell
bun run test
```

Expected: all green, zero failures (excluding pre-existing baseline failures noted in memory: `QueryHistory.test.ts`, `sql-splitter.test.ts` — those are pre-existing).

- [ ] **Step 17.2: Sidecar tests**

```powershell
cd sidecar
bun test
cd ..
```

Expected: all green.

- [ ] **Step 17.3: Rust tests**

```powershell
cd src-tauri
cargo test --lib
cd ..
```

Expected: all green, including new `migration_creates_command_history_table`.

- [ ] **Step 17.4: Lint**

```powershell
bun run lint
cd src-tauri
cargo clippy -- -D warnings
cd ..
```

Expected: zero warnings.

- [ ] **Step 17.5: TypeScript check**

```powershell
bun run check
```

Expected: zero errors.

- [ ] **Step 17.6: If any of the above fails — fix it before continuing.**

This is the gate. The next task assumes everything is green.

---

### Task 18: Manual smoke validation (gate)

- [ ] **Step 18.1: Run dev**

```powershell
bun run tauri dev
```

- [ ] **Step 18.2: Walk the smoke checklist**

Exercise each in order against an Oracle 23ai connection:

1. Open a connection, click `+` (or new dropdown) → "New Command Window" → tab opens with `SQL>` prompt.
2. Type `SELECT 'hello' FROM dual;` → returns `'HELLO'\n-----\nhello\n\n1 row selected in 0.0XX seconds.\n`.
3. Type `DESC dual` → table description renders.
4. Type `SET LINESIZE 40` → next SELECT wraps narrower.
5. Type `SET PAGESIZE 5\nSELECT * FROM all_objects WHERE rownum<15;` → header repeats every 5 rows.
6. Type a multi-line PL/SQL block ending with `/`:
   ```
   BEGIN
     dbms_output.put_line('hi');
   END;
   /
   ```
   Output: `hi\n\nPL/SQL procedure successfully completed.`
7. Type `COMMIT` → `Commit complete.`
8. Type `ROLLBACK` → `Rollback complete.`
9. Press `↑` arrow → previous command appears at prompt; `↓` cycles back.
10. Type `TRUNCATE TABLE foo;` (with foo non-existing) → ORA-00942 in red. With existing table, the unsafe-DML modal fires (prove it gates the execution).
11. Type `EXIT` → tab closes.
12. Reopen connection, open Command Window again → ↑ shows prior session's commands.
13. Save a 3-statement SQL script to disk; run `@C:\path\to\script.sql` → all three execute in order, output streams.

- [ ] **Step 18.3: If anything fails, document the bug and fix before merge**

---

## Self-Review Checklist (run after writing the plan)

**Spec coverage:**
- Tab type integration → Tasks 11, 15
- Renderer xterm + line editor → Tasks 8, 14
- Parser Tier 1 → Task 5
- Executor + pipeline reuse → Tasks 10, 13
- Formatter LINESIZE/PAGESIZE → Task 6
- State management runes → Task 7
- `command_history` migration v7 + Tauri commands → Tasks 1, 2
- AI approval / TRUNCATE / Dry Run / PSDPM — inherited via `runStatementShared` (Task 10)
- `@` script execution → Task 12 + executor handler in 13
- EXIT → Task 13
- Ctrl+Shift+N shortcut → Task 16
- Manual smoke → Task 18

**Deferred to D.2/D.3 (intentional):** Bind vars, substitution, SPOOL, COL FORMAT, BREAK/COMPUTE, AUTOTRACE, LIST/SAVE/RUN/EDIT, sub-tabs Dialog/Editor, AcceptModal.

**Type consistency check:** `SharedExecResult` defined in Task 3, consumed in Tasks 10 and 13. `CommandState` defined in Task 7, mutated in Task 13. `Parsed` defined in Task 3, returned by Task 5, consumed by Task 13.

**Placeholder scan:** None. Every code block is complete.

---

## What ships at end of D.1

A working Command Window tab in CE main:
- `Ctrl+Shift+N` or new-tab menu opens it.
- Runs SELECT / DML / PL/SQL via the same pipeline as SqlEditor.
- All Sprint A/B/C safety guards apply (audit chain, AI approval modal, TRUNCATE confirm, Dry Run, PSDPM, encryption-at-rest).
- Tier 1 directives: SET (LINESIZE, PAGESIZE, FEEDBACK, ECHO, TIMING, HEADING, SERVEROUTPUT, TERMOUT, WRAP, TRIMOUT, TRIMSPOOL, VERIFY, NULL, COLSEP, NUMWIDTH, PAGES alias), DESC[RIBE], COMMIT, ROLLBACK, PROMPT, EXIT/QUIT, CLEAR SCREEN/BUFFER, @ / @@ scripts.
- Persistent history per connection in SQLCipher-encrypted veesker.db.
- ↑/↓ history navigation across sessions.
- Fonte/tema dark match PL/SQL Dev visual.

What's left for D.2 (next plan): bind variables, substitution variables, SPOOL, WHENEVER, AcceptModal.

What's left for D.3 (plan after that): COL FORMAT, BREAK/COMPUTE, AUTOTRACE, LIST/SAVE/RUN/EDIT, sub-tabs Dialog/Editor.
