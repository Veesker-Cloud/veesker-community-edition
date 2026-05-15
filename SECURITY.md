# Security Policy

## Supported Versions

Only the latest release receives security updates.

| Version | Supported |
|---|---|
| Latest | ✅ |
| Older  | ❌ |

## Reporting a Vulnerability

Email **security@veesker.cloud** with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Optional: suggested fix

We aim to acknowledge reports within **72 hours** and provide a fix timeline within **7 days** for critical issues. We will credit reporters in release notes unless anonymity is requested.

Please do not open public GitHub issues for security vulnerabilities.

## Security Architecture

### Credential Storage
Passwords and API keys are stored exclusively in the OS keychain:
- **Windows**: Windows Credential Manager (`veesker:` prefix)
- **macOS**: macOS Keychain (`veesker:` prefix)
- **Linux**: libsecret / GNOME Keyring

Credentials are never written to SQLite, log files, or audit files. They are transmitted only over a localhost stdin/stdout pipe (the Tauri IPC channel) to open Oracle sessions.

### SQL Execution Model
Every SQL statement requires explicit user action (clicking Run or pressing the execute shortcut). Veesker never:
- Executes SQL in the background
- Auto-commits transactions
- Runs scheduled or timed queries

`oracledb.autoCommit` is set to `false` globally and repeated on every execute call. Users must explicitly COMMIT or ROLLBACK.

### AI Boundaries (Sheep assistant)
The AI assistant suggests SQL and explains results — it never executes anything autonomously.

**What Sheep sends to `api.anthropic.com`:**
- Schema names, table names, column names
- SQL you write and submit for analysis
- Query result samples (up to 50 rows by default)
- Oracle database version string

**What Sheep never sends:**
- Passwords or connection strings
- Wallet files or certificate data
- Full table dumps or bulk data exports
- Data from schemas marked as sensitive (Cloud Edition)

An explicit disclosure modal is shown before AI can be used on a connection. The sidecar also enforces a secondary gate — AI calls on production-tagged connections require per-session acknowledgement.

### Audit Trail
Every executed statement is written to `<app_data>/audit/YYYY-MM-DD.jsonl` by the Rust host process (`src-tauri/src/commands.rs → write_audit_entry()`). This write happens in the native layer — a compromised renderer cannot suppress it. Each entry records: timestamp, connection id, host, username, SQL, success/failure, row count, elapsed time, env tag, and origin (user-typed / AI tool call / system).

Each line is encrypted with AES-256-GCM before write (`src-tauri/src/crypto.rs → encrypt_audit_line()`): 12-byte random nonce, 16-byte AEAD tag, base64-encoded, prefixed `02:`. The decryption key lives in the OS keychain under `veesker:audit-cipher-key` and is never written to disk.

#### Why Audit Preserves Raw SQL

The audit JSONL records the SQL statement exactly as submitted — inside the AES-256-GCM ciphertext — without PII masking.

PII masking (CPF, CNPJ, email, credit card, phone, RG patterns — `src-tauri/src/pii.rs`) is applied to query history (`command_history` table) but deliberately **not** to audit entries. The audit is a forensic record: if a query caused a data breach or a compliance incident, the exact SQL must be reproducible. Masking at write time destroys forensic value.

The raw SQL is protected by encryption at rest — a filesystem-level attacker who reads the audit files gets ciphertext, not plaintext. This is a deliberate design decision, not an oversight.

### Read-Only Mode
When a connection is configured as read-only, the sidecar (`sidecar/src/oracle.ts → enforceSafetyForStatement()`) rejects any non-SELECT statement with error code `-32030` before it reaches Oracle. This guard is enforced server-side and cannot be bypassed by the UI layer.

**DML safety scope:** `enforceSafetyForStatement()` also enforces per-env DML confirmation for `DELETE`/`UPDATE` without `WHERE`, `TRUNCATE`, and `MERGE` (`sidecar/src/oracle.ts:1217–1310`). DDL and DCL statements (`DROP`, `GRANT`, `REVOKE`, `ALTER USER`, `SHUTDOWN`) currently pass through without a confirmation dialog — this is a known gap addressed in the next release (roadmap Phase 1 Item #1A).

### Content Security Policy
The WebView CSP does not allow `eval`, inline scripts, or arbitrary network connections. The `connect-src` directive is limited to the Tauri IPC channel and `api.veesker.cloud`. The Anthropic API is called from the sidecar process, not the WebView.

## Known Limitations

- **Query history is encrypted at rest** (AES-256-GCM per row, key in OS keychain, fail-closed via `src-tauri/src/crypto.rs → get_or_create_command_history_key()`). If the keychain is unavailable the history is disabled for the session rather than falling back to plaintext. Legacy rows written before encryption was introduced remain readable for backward compatibility.
- **AI read-only enforcement is keyword-based**, not parse-based. The SQL tokenizer handles Oracle-specific syntax (q-quoted strings, block comments) but cannot provide formal guarantees against all SQL injection vectors in AI-generated content.

## Open Source Auditability

All safety-critical code is in this Apache 2.0 repository. You can read, audit, and compile every line that touches your Oracle database — including premium features.

Key files to review:
- `sidecar/src/oracle.ts` — all Oracle operations, safety guards, auto-commit enforcement, env-calibrated DML tiers
- `sidecar/src/sql-kind.ts` — SQL classification and unsafe DML detection (`classifySql`, `isUnsafeBulkDml`)
- `sidecar/src/ai.ts` — AI integration, what data is sent, PROD gate (`enforcePsdpmForOrigin`)
- `src-tauri/src/commands.rs` — audit logging (`write_audit_entry`), credential handling, SSRF protections
- `src-tauri/src/crypto.rs` — AES-256-GCM encryption for audit JSONL and command history
- `src-tauri/src/pii.rs` — PII masking patterns applied to command history
- `src-tauri/src/audit/chain.rs` — HMAC-SHA256 tamper-evident chain implementation

## Verifying Veesker binaries

The current beta releases (v0.5.0-beta.x) are distributed **unsigned**.
Code signing certificates are in progress:

- **Windows**: Azure Trusted Signing certificate awaiting Microsoft approval.
- **macOS**: Apple Developer ID Application certificate to be provisioned post-approval.
- **Linux**: distributed as static binaries — signing is via checksum verification.

This means SmartScreen (Windows) and Gatekeeper (macOS) will warn on first run.
This section documents how to verify the binary authenticity until signing is wired.

### Windows (.exe / .msi)

When you first run a Veesker installer, SmartScreen may display:

> *Windows protected your PC — Microsoft Defender SmartScreen prevented an
> unrecognized app from starting.*

This is expected for unsigned binaries from non-Microsoft developers. To proceed:

1. Click **More info**
2. Click **Run anyway**

To verify the installer matches the GitHub release **before** running:

```powershell
# Compute the SHA-256 of your downloaded installer
Get-FileHash .\Veesker_0.5.0-beta.X_x64-setup.exe -Algorithm SHA256

# Compare against the value published at:
# https://github.com/Veesker-Cloud/veesker-community-edition/releases/tag/v0.5.0-beta.X
# (look for the SHA256 entries in the release notes)
```

### macOS (.dmg / .app)

Unsigned macOS binaries are flagged by Gatekeeper. You may see:

> *"Veesker" cannot be opened because the developer cannot be verified.*

To unquarantine the application after verifying the SHA-256:

```bash
# Verify SHA-256 first (compare against the GitHub release page)
shasum -a 256 ~/Downloads/Veesker_0.5.0-beta.X_aarch64.dmg

# After mounting the DMG and copying Veesker.app to /Applications:
xattr -d com.apple.quarantine /Applications/Veesker.app
```

Note: this only removes the quarantine extended attribute. Gatekeeper itself
is not disabled and other apps remain protected.

### Linux (.AppImage / .deb / .rpm)

Verify the SHA-256 of any downloaded artifact against the value in the
matching GitHub release:

```bash
sha256sum Veesker_0.5.0-beta.X_amd64.AppImage
# Compare against the SHA256 line in:
# https://github.com/Veesker-Cloud/veesker-community-edition/releases/tag/v0.5.0-beta.X
```

### After signing is wired

Once Azure Trusted Signing and Apple Developer ID are wired (target: v0.5.1
or v0.6.0), this section will be replaced with verification via the platform
certificate chains. Until then, SHA-256 verification is the canonical path.

## Repository consolidation (2026-05-13)

On 2026-05-13, the internal `veesker-cloud-edition` (CL) private repository was consolidated into this public repository. As part of that cleanup, internal planning documents (`docs/superpowers/`, `CLAUDE.md` dev notes) were removed from the public tree and archived separately. These files contained implementation plans, AI session logs, and code conventions — not credentials or user data.

No credentials, connection strings, API keys, or user data were ever stored in either repository. If you have concerns about anything you observed in the repository history before this date, report it to **security@veesker.cloud**.

## Scope

This security policy covers the **Veesker desktop application** (this repository). The backend SaaS (`api.veesker.cloud`) is a separate private service with its own security posture. Vulnerabilities found in `api.veesker.cloud` infrastructure (not reproducible from the desktop app source alone) should still be reported to **security@veesker.cloud** — we will route them appropriately.
