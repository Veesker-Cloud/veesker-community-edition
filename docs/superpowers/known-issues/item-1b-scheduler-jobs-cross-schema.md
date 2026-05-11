# Scheduler Jobs Cross-Schema USER Fallback (LOW)

## Status

Open. Documented proactively after Item B2 fix (PR #56).

## Symptom

When browsing another user's schema (e.g., admin connecting as `admin`
and browsing schema `GIMBIAS`) without access to `DBA_SCHEDULER_JOBS`,
the `USER_SCHEDULER_JOBS` fallback returns the *browser's* own jobs
labeled with the target schema's owner name.

## Root cause

`USER_SCHEDULER_JOBS` returns jobs owned by the current session user.
When the DBA→ALL fallback path is reached, the code runs `ALL_SCHEDULER_JOBS`
and `USER_SCHEDULER_JOBS` in parallel, injecting `:owner` as the synthetic
OWNER column for the USER query. If the browser is not the schema owner,
USER_SCHEDULER_JOBS returns the session user's jobs with the wrong OWNER label.

## Conditions required to trigger

1. Connected user ≠ the schema being browsed (cross-schema view)
2. Connected user has no access to `DBA_SCHEDULER_JOBS` (no DBA role)
3. Connected user has no access to the target's jobs via `ALL_SCHEDULER_JOBS`
4. Connected user has their own `USER_SCHEDULER_JOBS` entries

All four conditions must be true simultaneously — uncommon for DBA users, who
typically have `DBA_SCHEDULER_JOBS` access (condition 2 = false).

## Impact

- **Severity:** LOW
- **Misattribution:** browser's jobs appear in the wrong schema tree
- **Affected users:** non-DBA users browsing another user's schema

## Workaround

Grant `SELECT` on `DBA_SCHEDULER_JOBS` (via `SELECT_CATALOG_ROLE`) to the
connecting user, bypassing the ALL+USER fallback path entirely.

## Resolution

Not planned for v0.5.x. Candidates for Phase 2:
- Query `SELECT USER FROM DUAL` at fallback entry and skip USER_SCHEDULER_JOBS
  when `session_user ≠ p.owner`
- Multi-connection refactor (Item #6) will restructure session-aware queries
