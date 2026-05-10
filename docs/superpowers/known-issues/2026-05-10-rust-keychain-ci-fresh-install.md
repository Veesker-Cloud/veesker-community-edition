# Rust Test Keychain Failure in CI — fresh_install (2026-05-10)

## Status
Open. Documented as known-issue, does not block merges.

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

## Workarounds considered
- Mark test as `#[cfg(target_os = "windows")]` only
  (loses cross-platform validation)
- Move to integration tests with `#[ignore]` flag
  (test never runs, defeats purpose)
- Mock keychain in test environment
  (most correct, requires refactor)
- Use secret-service CI helper (Ubuntu) + unlock keychain
  (macOS) in workflow setup
  (most accurate, requires CI workflow changes)

## Decision
Defer to dedicated CI-fix sprint. Document as known-issue
to prevent confusion in future PRs. Pattern similar to
ai.test.ts timing issue resolved in T1B.0.

## Future fix candidates
- Likely T1C.X or dedicated CI-improvement task
- Estimated effort: 2-4h investigation + fix + verification
