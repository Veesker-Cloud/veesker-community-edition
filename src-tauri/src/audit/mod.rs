// Local audit log helpers. Kept independent of the rest of the crate so
// these modules can be unit-tested without an `AppHandle` or any Tauri
// state.
//
// SOURCE OF TRUTH for the redaction patterns: src/lib/services/redactSql.ts
// and the matching server-side file in veesker-cloud-api. Keep all three
// in sync — credentials must never appear in any audit pipeline.

pub mod chain;
pub mod redact;
