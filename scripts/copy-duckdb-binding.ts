#!/usr/bin/env bun
/**
 * Copies DuckDB's native shared library (`duckdb.dll` / `libduckdb.dylib` /
 * `libduckdb.so`) from the bun-linked `@veesker/engine` dependency tree into
 * `src-tauri/binaries/` so it can be bundled by Tauri as a resource.
 *
 * Why: Bun's `--compile` bundles `duckdb.node` into the sidecar binary's
 * virtual filesystem. At runtime the .node is extracted to a temp dir and
 * Windows LoadLibrary tries to resolve its sibling `duckdb.dll` — which is
 * NOT extracted by Bun. The result is `ERR_DLOPEN_FAILED`. Shipping the .dll
 * alongside the sidecar binary plus prepending that directory to PATH (handled
 * by `src-tauri/src/sidecar.rs:resolve_duckdb_binding_dir`) makes LoadLibrary
 * find it.
 *
 * The script auto-detects the host platform and copies only the shared library
 * needed for that platform. The `.node` itself stays inside the Bun bundle.
 *
 * Run automatically before every `tauri build` via the root package.json `build`
 * script. Manual invocation: `bun run scripts/copy-duckdb-binding.ts`.
 */

import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `@veesker/engine` is bun-linked from CE repo: cl/sidecar pulls it via
// `link:@veesker/engine`, but the actual binding payload (`duckdb.dll` etc.)
// lives in CE's node_modules under Bun's cache layout (`.bun/<pkg>@<ver>/...`).
//
// CE may be checked out under several conventions:
// - Local dev (per CLAUDE.md): repo siblings `../ce/`, `../cl/`, `../api/`,
//   `../site/` under a master vault root.
// - CL CI (`.github/workflows/ci.yml`): `actions/checkout` puts the CE repo
//   inside the CL workspace at `veesker-community-edition/`, then runs
//   `bun install` inside `veesker-community-edition/engine/`.
// - Master-vault dev (`veesker-project/cl/` with `veesker-project/ce/` sibling)
//   resolves the same as the local sibling case once we walk up to the master
//   root.
// Try each candidate in order; the first one whose `.bun` cache exists wins.
const CANDIDATE_CE_ENGINE_ROOTS = [
  resolve(REPO_ROOT, "..", "ce", "engine"),
  resolve(REPO_ROOT, "..", "ce"),
  resolve(REPO_ROOT, "..", "veesker-community-edition", "engine"),
  resolve(REPO_ROOT, "..", "veesker-community-edition"),
  join(REPO_ROOT, "veesker-community-edition", "engine"),
  join(REPO_ROOT, "veesker-community-edition"),
];

function findCeBunCache(): string | null {
  for (const root of CANDIDATE_CE_ENGINE_ROOTS) {
    const cache = join(root, "node_modules", ".bun");
    if (existsSync(cache)) return cache;
  }
  return null;
}

const CE_BUN_CACHE = findCeBunCache();

const TARGET_DIR = join(REPO_ROOT, "src-tauri", "binaries");

const PLATFORM_BINDING: Record<string, { dir: string; libs: string[] }> = {
  "win32-x64": { dir: "win32-x64", libs: ["duckdb.dll"] },
  "darwin-x64": { dir: "darwin-x64", libs: ["libduckdb.dylib"] },
  "darwin-arm64": { dir: "darwin-arm64", libs: ["libduckdb.dylib"] },
  "linux-x64": { dir: "linux-x64", libs: ["libduckdb.so"] },
  "linux-arm64": { dir: "linux-arm64", libs: ["libduckdb.so"] },
};

const platformKey = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
const target = PLATFORM_BINDING[platformKey];
if (!target) {
  console.error(`[duckdb-binding] unsupported platform: ${platformKey}`);
  process.exit(1);
}

if (CE_BUN_CACHE === null) {
  console.error("[duckdb-binding] CE bun cache not found in any candidate root:");
  for (const root of CANDIDATE_CE_ENGINE_ROOTS) {
    console.error(`  - ${join(root, "node_modules", ".bun")}`);
  }
  console.error("[duckdb-binding] run `bun install` inside the CE engine first");
  process.exit(1);
}

const cacheEntries = readdirSync(CE_BUN_CACHE);
const prefix = `@duckdb+node-bindings-${target.dir}@`;
const match = cacheEntries.find((d) => d.startsWith(prefix));
if (!match) {
  console.error(`[duckdb-binding] no entry matching ${prefix}* in ${CE_BUN_CACHE}`);
  process.exit(1);
}

const SOURCE_DIR = join(
  CE_BUN_CACHE,
  match,
  "node_modules",
  "@duckdb",
  `node-bindings-${target.dir}`,
);

if (!existsSync(SOURCE_DIR)) {
  console.error(`[duckdb-binding] resolved source missing: ${SOURCE_DIR}`);
  process.exit(1);
}

mkdirSync(TARGET_DIR, { recursive: true });

let copied = 0;
let upToDate = 0;
for (const lib of target.libs) {
  const src = join(SOURCE_DIR, lib);
  const dst = join(TARGET_DIR, lib);
  if (!existsSync(src)) {
    console.error(`[duckdb-binding] expected library missing in source: ${src}`);
    process.exit(1);
  }
  if (existsSync(dst)) {
    const srcStat = statSync(src);
    const dstStat = statSync(dst);
    if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs) {
      upToDate++;
      continue;
    }
  }
  copyFileSync(src, dst);
  console.log(`[duckdb-binding] copied ${lib}`);
  copied++;
}

console.log(
  `[duckdb-binding] ${copied} copied, ${upToDate} up-to-date — target ${TARGET_DIR}`,
);
