# CI Test Timing Issue — ai.test.ts (2026-05-10)

## Status

Open. Investigation scheduled as T1B.0 before Item #1B implementation begins.

## Summary

3 tests in `sidecar/src/ai.test.ts` fail on CI runners Linux/macOS but pass on
Windows local and Windows CI.

## Affected Tests

- `aiChat (PROD-001 prod-connection gate) > refuses without acknowledgeProdAi when env=prod`
- `executeTool L3.6 per-statement approval gate > PSDPM lock short-circuits BEFORE the approval gate (spy count = 0)`
- `executeTool L3.6 per-statement approval gate > PSDPM via env=prod also short-circuits before the gate`

## Reproduction Matrix

| Environment | Suite result |
|---|---|
| Local Windows — full suite | 363 pass / 0 fail |
| Local Windows — ai.test.ts isolated | 39 pass / 0 fail |
| CI Windows — full suite | 363 pass / 0 fail |
| CI macOS — full suite | 360 pass / **3 fail** |
| CI Ubuntu — full suite | 360 pass / **3 fail** |

## Hypothesis

Mock isolation issue combined with async timing race condition on Linux/macOS CI runners.
`mock.module("./state", ...)` introduced in `item-1a.test.ts` (and existing in other test
files) may be leaking state between files when tests run in parallel with CI-specific timing.

The 3 failing tests rely on `getSessionSafety()` returning a specific env value — if another
test file's `mock.module("./state")` registration wins the module cache race on a Linux/macOS
runner, `ai.test.ts` may see stale mock state from a different test file.

## Impact

- **Product (Veesker app):** ZERO impact. App functions correctly on all platforms.
- **CI suite:** Red on macOS and Ubuntu runners (3 fails out of 363).
- **Releases:** Does not block. Windows + Linux build artifacts pass their respective CI gates.

## Next Action

T1B.0 (first task of Item #1B): investigate and fix test pollution in `ai.test.ts`.
Estimated 1–2 h, Sonnet investigation with Opus review.

Fix strategy candidates:
1. Add explicit `mock.restoreAllMocks()` / module cache reset between files
2. Use `describe`-scoped mocks instead of top-level `mock.module` where possible
3. Convert affected tests to use `vi.mock` / Bun-native isolation per file

Spike must reproduce failure on Linux first (WSL or CI trigger), then fix and verify
cross-platform green before closing.
