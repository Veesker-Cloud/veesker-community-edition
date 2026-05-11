# Rust Test Keychain Failure in CI — fresh_install (2026-05-10)

## Status

**Resolved in PR #55 (2026-05-11)**

## Affected Test

persistence::connections::encryption_tests::open_encrypted_or_migrate_handles_fresh_install

## Symptom

Fails in CI runners macOS + Ubuntu with:
- "db-master: could not persist key to keychain"
- "verify sqlcipher key (wrong key or corrupted db): file is not a database"

Passes in CI Windows + local Windows + local macOS/Linux with
unlocked keychain.

## Root cause

Test depends on real OS keychain to persist db-master key.
GitHub Actions runners macOS and Ubuntu don't have unlocked
keychain by default (no GUI session).

## Pre-existence proof

- Run 25627784517 on main (2026-05-10 11:45, BEFORE PR #48):
  137 passed / 1 failed / 2 ignored, same test, same error
- Run on PR #48 (2026-05-10 12:11): identical output

## Impact

- Product Veesker: ZERO. Real users have keychain available.
- CI suite: 1 Rust test red on macOS + Ubuntu permanently
  until fixed.
- Releases: NOT blocked (Windows build green, code works).

## Reproducibility

- Reproduces consistently in CI macOS/Ubuntu
- Does NOT reproduce in CI Windows
- Does NOT reproduce locally on developer machines

## Resolution (PR #55 — 2026-05-11)

CI workflow updated to unlock the keychain on both affected platforms
before the Rust test step runs.

**Ubuntu:** `gnome-keyring` + `libsecret-1` + `dbus-x11` installed
via apt; `dbus-launch --sh-syntax` starts the D-Bus session daemon;
`gnome-keyring-daemon --start --components=secrets` provides the
secret-service interface; `DBUS_SESSION_BUS_ADDRESS` and
`GNOME_KEYRING_CONTROL` exported to subsequent steps via `$GITHUB_ENV`.

**macOS:** `security create-keychain -p "" build.keychain` creates a
temporary keychain with empty password; set as default and unlocked;
auto-lock inactivity timeout set to 3600 s so it stays unlocked for the full
run duration.

**Additional test added:** `open_encrypted_handles_zeroed_key_fallback`
validates that `db_key_as_sqlcipher_pragma_arg` + `open_with_pragma_key`
work correctly with a zeroed 32-byte key (the fallback path when the
keychain is truly unavailable). This test runs on all platforms without
touching the keychain, ensuring the graceful-degradation path is
verified regardless of runner OS.

Both paths — real keychain on Ubuntu/macOS and zeroed-key fallback —
are now validated in CI.
