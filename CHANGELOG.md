# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0-beta.2] — 2026-05-14

Repository unification release. All previously private Cloud Edition (CL)
features now live in this public repository under Apache 2.0. Premium
features will be runtime-gated by a feature flag served by
`api.veesker.cloud` (gating wiring lands in 0.5.0-beta.3).

### Architecture

- **Repository unification (2026-05-13):** all code from the private
  `veesker-cloud-edition` repository was migrated to this public repository.
  The CL repo is being archived. No features are removed — every feature
  is now Apache 2.0 source. Premium features remain runtime-gated via a
  feature flag served by `api.veesker.cloud` (gating wires up in beta.3).
- **Open-core model clarification:** the "Community Edition vs Cloud
  Edition" framing (two separate binaries) is retired. One binary, one
  repository. Free tier = all core features. Subscription tier = premium
  features unlocked at runtime. Source for every feature is public.
- Internal planning documents (`docs/superpowers/`, `CLAUDE.md` internal
  dev notes) were removed from the public tree and archived privately as
  part of the cleanup.

### Added — from CL → CE unification (PR #88)

- **Sandboxes** — full read-only workspace export to a shareable static
  bundle. Routes: `/sandboxes` (list), `/sandboxes/[id]` (view),
  `/sandboxes/publish` (export wizard). Bundle stored on Cloudflare R2.
- **Vision graph** — entity-relationship visualizer for the active schema.
  New `Vision*` types in the sidecar, graph rendering in the workspace.
- **Vector index UI for Oracle 23ai** — new "Vectors" tab in the object
  inspector for vector index creation, parameter tuning, and ANN search.
- **Schema-aware AI prompts** — AI assistant now receives a schema-grounded
  context (object names, column types, relationships) so generated SQL
  references real objects instead of placeholders.

### Fixed

- **Audit chain advance order (HMAC-SHA256 integrity bug-fix).** The
  in-memory chain pointer now advances only AFTER the audit line is
  durably written to disk. Previously, a disk-write failure could
  leave the in-memory `prevHash` ahead of disk, producing a skewed
  chain on next entry. (PR #88 — `commands.rs`)
- **`audit_verify_chain` rate limiting.** Verification is now gated to
  one call per 60 s per process (via `VerifyChainRateLimit` state),
  preventing accidental N+1 verification storms from the UI. (PR #88)
- **`tauri.conf.json` resource glob `binaries/*duckdb*` removed** —
  DuckDB was removed earlier; the dangling glob was failing
  `tauri-build`. (PR #88)
- **`oracleTypeFor` return type migrated to `oracledb.DbType`** —
  correct for `oracledb >= 6.x`. (PR #88)
- Schema tree freeze and `each_key_duplicate` exception when re-expanding
  pre-loaded schemas. Pragmatic workaround: `{#each}` blocks in
  `SchemaTree.svelte` converted to non-keyed iteration. Root cause
  (Svelte 5 proxy chain behavior with immutable spread patterns) remains
  under investigation as tech debt — see `DEBT.md`.
- **BUG-1 — Workspace stuck on "Loading workspace..." after crash/reopen.**
  Added a 20-second boot call-timeout before `applySessionIdentification`;
  subsequent queries inherit the user-configured session timeout. Changed
  `void bootstrap()` to `.catch()` so unexpected errors surface as a
  dismissible error instead of silent freeze.
- **BUG-2 — PLAN tab empty + `ORA-00904: FILTER_PREDICATES` after Explain
  Plan.** Two-phase fix: write phase catches stale `PLAN_TABLE` and
  throws `PLAN_TABLE_STALE` with actionable remediation; auto-explain
  propagates the error to the PLAN tab instead of swallowing it.
  `retryAutoExplain()` re-runs the plan in place after the user fixes
  the schema. (PR #73)
- **BUG-3 — Terminal expanded with blinking cursor but ignores keyboard
  input.** Host `<div>` for xterm.js is now permanently mounted (hidden
  via `display: none` when minimized) instead of being destroyed by
  `{#if !minimized}`. ResizeObserver guard added against zero-dimension
  hosts.
- Download page on veesker.cloud was showing v0.2.4 after v0.5.0-beta.1.
  Manual update applied + CD pipeline fixes.
- Site `/changelog` had editorial dates that did not match git tag dates.
  All entries corrected to match `git log --tags` timestamps.

### CI / Build

- **Restore Ubuntu/macOS keychain setup in `ci.yml`** — PR #83 squash had
  inadvertently overwritten this with the pre-keychain version of the
  workflow. Restored `gnome-keyring`, `libsecret-1-0`, `libsecret-1-dev`,
  `dbus-x11` Ubuntu deps + `Setup keyring (Ubuntu)` and `Setup keychain
  (macOS)` steps from commit `c0c4c6c`. (PR #90)
- **Restore release.yml fixes regressed by PR #83.** The CL→CE
  unification squash overwrote four release.yml fixes that landed
  pre-unification:
  - `--bundles nsis` restored on the Windows build matrix (MSI bundle
    does not support semver pre-release versions; without this, MSI
    fails on `-beta.X` / `-rc.X` tags). Restored from `f228f0c`.
  - `sed` regex `[0-9.]*` → `[^"]*` for the site download page bump
    (matches pre-release strings). Restored from `599dddc`.
  - Additional `sed` over `src/app.html` JSON-LD `softwareVersion`
    field (so SEO structured data ships with the correct version).
    Restored from `e4097c6`.
  - Step name normalized to `Update site version`; commit message
    normalized to `chore(release): bump version to …` (matches the
    convention used by the rest of the release pipeline).
    Restored from `e4097c6`.
- **Sidecar DDL gate tests** — `oracle-query.test.ts` and
  `tx-state.test.ts` now open a DDL window before exercising DDL
  statements, matching the runtime behavior introduced by Item #1E.
  (PR #89)
- **`open_encrypted_or_migrate_handles_fresh_install` ignored on Linux**
  — GitHub Actions Ubuntu image drift (gnome-keyring 46.1 default-
  collection behavior) caused `set_password` to silent-fail on the
  runner, preventing the SQLCipher key from persisting across the
  test's two open calls. Test is `#[cfg_attr(target_os = "linux",
  ignore = "...")]`-marked, consistent with the `secrets.rs:125`
  convention. Tracked in `DEBT.md` for a fail-loud refactor of
  `crypto::get_or_create_key`. (PR #91)
- **`osv-scanner-action` restored to `v2.3.8`** — PR #83 squash had
  downgraded it to `v2.0.2`; restored to match the dependabot upgrade
  shipped in PR #58.

### Known Issues

- **Directory detail panel** — even with `SELECT on DBA_DIRECTORIES`
  privilege, the inspector still shows "Directory details not available
  (requires SELECT on DBA_DIRECTORIES)" instead of displaying directory
  metadata. The directory list works correctly. Investigation pending —
  fix planned for v0.5.x.
- **Sidecar stale binary** (source-build only) — if you cloned the repo
  and built from source before recent commits, rebuild the sidecar:
  `cd sidecar && bun run build:win-x64`. Pre-built release binaries are
  current and unaffected.
- **`crypto::get_or_create_key` silent-fail on Linux when keychain is
  unavailable** — falls back to a zeroed key, meaning encrypted data
  does not survive across runs. Fix planned (fail-loud) — tracked in
  `DEBT.md`.
- **Feature flag gating not yet wired** — premium features (Sandboxes,
  Vision graph, Vector indexes, schema-aware AI) are currently
  accessible regardless of subscription tier. Runtime gating lands in
  v0.5.0-beta.3.

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
