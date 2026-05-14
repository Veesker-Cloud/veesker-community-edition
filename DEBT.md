# Technical Debt

Known tech debt items deferred from the main roadmap. Each item links to a decision doc with full investigation history.

## Open Items

| ID | Area | File | Deferred Since | Decision Doc |
|----|------|------|----------------|-------------|
| DEBT-1 | Svelte 5 / SchemaTree | `src/lib/workspace/SchemaTree.svelte` | 2026-05-12 | [2026-05-12-schema-tree-keyed-each-debt.md](docs/superpowers/decisions/2026-05-12-schema-tree-keyed-each-debt.md) |

## Test reliability

- `connections::encryption_tests::open_encrypted_or_migrate_handles_fresh_install` is ignored on Linux CI as of 2026-05-13 due to gnome-keyring v46.1+ silent-fail in `set_password`. Re-enable when `get_or_create_key` (src-tauri/src/crypto.rs:109) is hardened to fail loud on `set_password` failure.

## Closed Items

_None yet._
