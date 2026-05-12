# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Schema tree freeze and `each_key_duplicate` exception when re-expanding pre-loaded schemas. Pragmatic workaround: `{#each}` blocks in `SchemaTree.svelte` converted to non-keyed iteration. Root cause (Svelte 5 proxy chain behavior with immutable spread patterns) remains under investigation as tech debt — see `DEBT.md`.
- **BUG-1 — Workspace stuck on "Loading workspace..." after crash/reopen.** `openSession()` had no call-timeout protecting `applySessionIdentification` and the bootstrap V$VERSION/SYS_CONTEXT queries. If Oracle accepted the TCP connection but stalled on SQL (e.g. during recovery or under load), `applySessionIdentification` hung forever, leaving `meta` and `info` unset and the workspace loading screen permanent. Added a 20-second boot call-timeout before `applySessionIdentification`; subsequent queries inherit the user-configured session timeout. Changed `void bootstrap()` to `.catch()` so unexpected errors surface as a dismissible error instead of silent freeze.
- **BUG-2 — PLAN tab empty + "Visual Flow failed: ORA-00904: FILTER_PREDICATES" after Explain Plan.** Two-phase fix: (1) `EXPLAIN PLAN FOR` write phase now catches ORA-00904 on stale `PLAN_TABLE` (missing `FILTER_PREDICATES`) and throws a `PLAN_TABLE_STALE` error with actionable remediation message; (2) auto-explain fire-and-forget propagates the error to the PLAN tab instead of swallowing it — users see the error message and a Retry button. `retryAutoExplain()` store action re-runs the plan in-place after the user fixes the schema. (PR #73)
- **BUG-3 — Terminal appears expanded with blinking cursor but ignores keyboard input.** xterm.js attaches to a host `<div>` once in `onMount`. The previous `{#if !minimized}` conditional destroyed and recreated that element on every minimize/restore cycle, leaving xterm bound to a detached (ghost) div — keystrokes fired `onData` but were swallowed by the ghost. Fixed by keeping the host `<div>` permanently in the DOM (hidden via `display: none` when minimized). Added a ResizeObserver guard against zero-dimension hosts to prevent accidental 0-column terminal resets while hidden.
- Download page on veesker.cloud was showing v0.2.4 after v0.5.0-beta.1 release. Manual update applied + CD pipeline fixes.
- `release.yml` sed regex was `[0-9.]*`, breaking on pre-release version strings (`-beta.X`, `-rc.X`). Changed to `[^"]*` to match any quoted version.
- `release.yml` "Update site version" step now updates `src/app.html` JSON-LD `softwareVersion` in addition to `src/routes/download/+page.svelte`. Previously only the download page was updated, leaving SEO structured data outdated.
- `SITE_DEPLOY_TOKEN` regenerated with correct owner scope (`veesker-cloud` org + `veesker-site` contents write). Original token used personal account scope, causing `git push` to fail with HTTP 403 on every release.
- Site `/changelog` had editorial dates that did not match actual git tag dates. All entries corrected to match `git log --tags` commit timestamps.

### Known Issues

- **Directory detail panel** — even with `SELECT on DBA_DIRECTORIES` privilege, the inspector still shows "Directory details not available (requires SELECT on DBA_DIRECTORIES)" instead of displaying directory metadata. The directory list works correctly. Investigation pending — fix planned for v0.5.x.

- **Sidecar stale binary** (source-build only) — if you cloned the repo and built from source before Phase 1 commits were merged, rebuild the sidecar binary: `cd sidecar && bun run build:win-x64`. Pre-built release binaries are current and unaffected.

## [0.5.0-beta.1] — 2026-05-11

Phase 1 complete — 9 new Oracle object kinds in schema browser, DDL/DCL safety gate, Sessions monitor, Privileges & Grants inspector, DB User inspector, and HMAC-SHA256 tamper-evident audit chain. **527 sidecar tests · 157 Rust tests · 0 failures.**

### Added

#### Schema Browser — 9 new object kinds

- **Materialized Views** (`MV`) — list, inspector with refresh mode / staleness / query text; `MVIEW.REFRESH` action with T1A.8 env guard (PR #46)
- **Synonyms** — list private and public synonyms; inspector with target object, DB Link, and DDL reconstruction fallback (PR #46)
- **DB Links** — list database links; inspector with username, host, target; DDL via `DBMS_METADATA` (PR #46)
- **Directories** — list OS directory objects; inspector with path, owner, grants; create/drop actions (PR #47)
- **Advanced Queues (AQ)** — list queues from `DBA_QUEUES`/`ALL_QUEUES`; inspector with payload type, enqueue/dequeue counts, retention (PR #48)
- **Scheduler Jobs** — list `DBMS_SCHEDULER` jobs; inspector with next run, last run, state, repeat interval; enable / disable / run actions with env guard (PR #49)
- **Legacy DBMS_JOB** — list legacy `DBMS_JOB` entries from `DBA_JOBS`/`USER_JOBS` (PR #50)
- **DB Users** (`DB_USER`) — `DBA_USERS` → `ALL_USERS` fallback; inspector with Profile / Quotas / Sessions / Grants sub-tabs (PR #51)
- **Privileges & Grants** (`PRIVILEGE`) — inspector with Role Privs / Sys Privs / Tab Privs / Granted To sub-tabs (PR #51)

#### Sessions Monitor (Item #1C — PR #51)

- Full `V$SESSION`/`GV$SESSION` view with real-time refresh
- `KILL SESSION` action with T1A.8 pattern — prod-confirm + env guard; no confirmation on dev/local/staging
- Blocking chain visualizer — shows which sessions are blocking which, with wait event details

#### DDL/DCL Confirmation Modal (Item #1E — PR #52)

- 5-minute per-connection DDL window — DDL requires explicit user confirmation, auto-expires after 5 min
- Explicit allowlist for dev/local environments — no confirmation required outside production
- `TRUNCATE` exempt from DDL gate (routed through DML-safety path instead)
- 3 audit JSONL events per gate interaction (open, approve, expire)

#### HMAC-SHA256 Tamper-Evident Audit Chain (Item #1D — PR #53)

- `audit/chain.rs` — HMAC-SHA256 linking every audit entry with `prevHash` + `hmac` fields; key stored in OS keychain (`veesker` / `audit-hmac-key`)
- Tamper detection: any modification to a past entry is detected at verification time
- Sub-chain model: app restarts begin a new sub-chain (`prevHash = "genesis"`) — not treated as false positives
- Durable write-before-advance: chain state advances only after the audit line is durably written to disk
- `audit_verify_chain` Tauri command — rate-limited (60 s minimum) to prevent abuse
- **Verify Chain UI** in Activity tab — "Verify Chain" button, `chain ✓` / `chain ✗` badge with entry count, legacy-skip count, sub-chain count in tooltip
- Break banner: when a break is detected, shows exact entry index, timestamp, and reason
- 157 new Rust tests covering HMAC mechanics, sub-chain boundaries, tamper detection, and rate limiting

#### Safety Architecture

- 4-layer PROD hard-lock: PSDPM (production safety decision point) → server-side env guard → `validateOracleIdentifier` → fail-closed defaults
- `validateOracleIdentifier` — validates Oracle identifiers (`/^[A-Z][A-Z0-9_$#]{0,127}$/`) before any write-path action; rejects injection attempts at the boundary
- Zero string interpolation in SQL — all owner/name pairs resolved via `:owner||'.'||:name` server-side; no user input ever reaches SQL string context
- 5 action buttons with Pattern T1A.8 (mview.refresh, job.run, job.disable, session.kill, DDL gate)

### Changed

- Schema browser now lists **18 object kinds** — original 9 (Table, View, Sequence, Procedure, Function, Package, Trigger, Type, REST Module) plus the 9 new Phase 1 kinds
- Audit log entries now include `prevHash` and `hmac` chain fields in addition to the existing 14 fields
- Activity tab header extended with "Verify Chain" button and chain integrity badge

### Fixed

- `DBMS_METADATA.GET_DDL` fallback reconstruction for object kinds that return XML or raise `ORA-31603` (affects Synonyms, DB Links, Directories on older instances)
- `DBA_*` → `ALL_*` → `SESSION_*`/`USER_*` fallback chain enforced for all 9 new object kinds — no hard dependency on DBA privilege

## [0.4.0] — 2026-05-06

Initial public Community Edition release. Establishes the safety baseline (env-calibrated DML safety, AES-256-GCM encrypted audit log, 4-keychain architecture) and the full IDE foundation (SQL editor, PL/SQL debugger, AI assistant, Vector Search Studio, ORDS builder).

See [v0.2.0] below for change history from earlier internal builds.

## [0.2.0] — 2026-04-28 — Community Edition

### Added
- **Community Edition identity** — Veesker is now officially branded as Community Edition (CE), free forever under Apache 2.0
- CE logo and branding throughout README and app
- Clear CE vs Cloud feature table in README
- Terminal panel (xterm.js + PTY backend) with minimize, right-dock, and resize
- Execute button (▶) for SQL queries in the dock toolbar
- Commit/Rollback transaction log entries with elapsed time
- ORDS bootstrap modal redesigned as subtle corner toast

### Fixed
- `oracledb.autoCommit` now explicitly set to `false` — prevents accidental DML commits regardless of driver version
- Terminal fills to bottom of container correctly
- Terminal PTY session preserved when docking position changes

### Changed
- AI assistant (BYOK) limited to text-only in CE — explain SQL and generate SQL without database tool access
- `CommercialUseModal` updated with clear CE free-forever messaging
