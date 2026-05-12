# DEBT-1 — SchemaTree each_key_duplicate root cause investigation

**Status:** Deferred — pragmatic workaround shipped (2e7462a).  
**Date opened:** 2026-05-12  
**Branch resolved on:** `feat/dor-1-and-2-schematree` (PR #75)  
**Workaround:** `{#each schemas as s}` and `{#each filtered as o}` — both converted to non-keyed iteration.

---

## Symptom

Collapsing GIMBIAS schema (pre-expanded at boot with 1019 tables) and re-expanding it threw:

```
Uncaught Svelte error: each_key_duplicate
Keyed each block has duplicate key `undefined` at indexes 0 and 1
in SchemaTree.svelte:275
```

The `{#if s.expanded}` block was DESTROYED on collapse and RECREATED on re-expand. The recreation path triggered fresh `{#each filtered as o (o.name)}` key evaluation. Items at indexes 0 and 1 had `key = undefined`, crashing the Svelte runtime and freezing the schema tree.

**Critical observation:** the error only occurred on re-expand. Initial boot expansion (same data, same component) worked correctly because the block was updated in-place (never destroyed/recreated).

---

## 4 Fix Attempts — All Failed

### Attempt 1 — `e8133f4`

**Hypothesis:** `expandIfNeeded(target)` received a plain object (from `{ ...s, expanded: !s.expanded }` spread in `.map()`), so mutations bypassed Svelte's proxy signal system.

**Fix:** Changed `onToggle` to capture `node` via `schemas.find()` after the `.map()` — returns reactive proxy instead of plain object.

**Result:** Bug persisted. ❌

---

### Attempt 2 — `42095d3`

**Hypothesis:** `{ ...s, expanded: !s.expanded }` spread in `onToggle` created a new plain object, re-wrapped by Svelte in a new proxy, potentially breaking nested proxy references (`kinds`, `loadable.value`).

**Fix:** Replaced `.map(s => ({...s, expanded}))` with direct proxy mutation `node.expanded = !node.expanded`.

**Result:** Bug persisted. ❌

---

### Attempt 3 — `ab18fd0`

**Hypothesis:** 36 `schemas = [...schemas]` calls during boot (17 `loadKind` starts + 17 `loadKind` ends + `kindCounts` + `vectorTables`) built up a corrupted proxy chain. After collapse, the `{#if s.expanded}` block was recreated and accessed `loadable.value[0].name` through the deeply-nested chain, returning `undefined`.

**Supporting evidence:** This is a known Svelte 3/4 anti-pattern — `state = [...state]` is unnecessary in runes mode and was expected to corrupt nested proxies after many cycles.

**Fix:** Removed all 4 `schemas = [...schemas]` calls from `loadKind` and `expandIfNeeded`.

**Result:** Bug persisted. Clean build confirmed. ❌

The spread hypothesis was definitively ruled out — removing all spreads had zero effect.

---

### Attempt 4 — Diagnostic branch `e0a076f`

Added `debugFiltered()` instrumentation to SchemaTree.svelte to log which `kind` triggered the error and what `filtered[0]` and `filtered[1]` contained (name, keys, ownKeys, protoName, JSON, Reflect.get).

**Status:** Not run to completion — team pivoted to pragmatic workaround before the diagnostic could be collected.

---

## Workaround — `2e7462a`

Converted both keyed `{#each}` blocks in `SchemaTree.svelte` to non-keyed:

```diff
- {#each schemas as s (s.name)}
+ {#each schemas as s}

- {#each filtered as o (o.name)}
+ {#each filtered as o}
```

**Why non-keyed is safe here:**
- Svelte still re-renders correctly without keys.
- Keys in `{#each}` are an optimization hint for DOM node reuse on reorder. Without keys, Svelte patches items in-place by index.
- No reordering of schemas or objects happens in the schema tree — items are always in the same API-returned order.
- Performance impact measured: none. 1019 tables rendered without visible degradation.

---

## Unverified Hypotheses for Future Investigation

1. **Svelte 5 proxy `ownKeys` trap on fresh block creation.** When the `{#if s.expanded}` block is recreated, Svelte may evaluate key expressions via a different proxy code path than the in-place update path. The `name` property may not be accessible through the re-wrapped proxy during the initial key collection phase.

2. **Race condition in async `loadKind`.** After collapse, multiple async `loadKind` promises (one per kind) may still be in flight if the user collapses before loading completes. On re-expand, one of those in-flight promises could write `node.kinds[kind] = { kind: "ok", value: res.data }` concurrently with the `{#if}` block recreation, leaving `loadable.value` in a partially-initialized state.

3. **`$state.snapshot()` / structural clone issue.** Svelte 5 internally uses `$state.snapshot()` in some paths to serialize/clone reactive values. If `loadable.value` is snapshotted and the clone doesn't preserve property descriptors (e.g. for proxied objects from `node-oracledb`), items could lose their `name` property.

4. **`node-oracledb` row objects.** `objectsList` returns rows from `node-oracledb`. Oracle result rows are NOT plain objects — they are special row descriptor objects with properties accessed via prototype chain or getters, not own properties. If Svelte 5's proxy system uses `Object.getOwnPropertyDescriptor` to check properties, it might not see `name` on a row prototype.

---

## How to Revisit

1. Run `chore/diagnostic-schema-toggle-logs` (commit `e0a076f`) and reproduce the bug.
2. Look for `[debug:each-key-dup]` entries in the browser DevTools console.
3. The log captures: `schema`, `kind`, `total`, `undefinedCount`, and per-item: `name`, `typeof name`, `hasName` (`in` check), `keys`, `ownKeys`, `protoName`, `json`, `Reflect.get(o, "name")`.
4. If `ownKeys` is empty but `Reflect.get` returns the name, it's hypothesis 1 (proxy trap).
5. If `protoName` is not `"Object"`, it's hypothesis 4 (oracledb row objects).

Once root cause is confirmed, revert the non-keyed workaround and apply a targeted fix. Keyed `{#each}` is preferable for correctness in sorted/filtered views.
