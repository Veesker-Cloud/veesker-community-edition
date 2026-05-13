import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleBuilds } from "./sweep-builds";

let testRoot: string;
let dir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "veesker-sweep-builds-"));
  // The sweep refuses any path that doesn't end in 'sandbox-builds'
  // (renderer-trust hardening), so every test puts files under that
  // canonical subdirectory.
  dir = join(testRoot, "sandbox-builds");
  mkdirSync(dir);
});

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function createFile(name: string, ageDays: number, contents = "x"): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  if (ageDays > 0) {
    const past = new Date(Date.now() - ageDays * 86400_000);
    utimesSync(path, past, past);
  }
  return path;
}

describe("sweepStaleBuilds", () => {
  it("returns zeros when the directory is empty", async () => {
    const r = await sweepStaleBuilds(dir, 7);
    expect(r).toEqual({ scanned: 0, removed: 0, errors: [] });
  });

  it("removes a .vsk file older than the TTL", async () => {
    const path = createFile("old.vsk", 8);
    const r = await sweepStaleBuilds(dir, 7);
    expect(r.scanned).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.errors).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a .vsk file younger than the TTL", async () => {
    const path = createFile("fresh.vsk", 1);
    const r = await sweepStaleBuilds(dir, 7);
    expect(r.scanned).toBe(1);
    expect(r.removed).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("ignores non-.vsk files even when they are old", async () => {
    const path = createFile("oldlog.txt", 30);
    const r = await sweepStaleBuilds(dir, 7);
    expect(r.scanned).toBe(0);
    expect(r.removed).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("processes a mix of files correctly", async () => {
    createFile("old1.vsk", 30);
    createFile("old2.vsk", 10);
    createFile("fresh.vsk", 1);
    createFile("not-vsk.bin", 99);
    const r = await sweepStaleBuilds(dir, 7);
    expect(r.scanned).toBe(3);
    expect(r.removed).toBe(2);
    expect(r.errors).toEqual([]);
    expect(existsSync(join(dir, "old1.vsk"))).toBe(false);
    expect(existsSync(join(dir, "old2.vsk"))).toBe(false);
    expect(existsSync(join(dir, "fresh.vsk"))).toBe(true);
    expect(existsSync(join(dir, "not-vsk.bin"))).toBe(true);
  });

  it("returns scanned=0 silently when the directory does not exist", async () => {
    const missing = join(testRoot, "missing", "sandbox-builds");
    const r = await sweepStaleBuilds(missing, 7);
    expect(r).toEqual({ scanned: 0, removed: 0, errors: [] });
  });

  it("throws when buildsDir does not end in 'sandbox-builds'", async () => {
    await expect(sweepStaleBuilds(testRoot, 7)).rejects.toThrow(
      /must end in 'sandbox-builds'/,
    );
  });

  it("throws when buildsDir is a sibling-named directory like 'evil-sandbox-builds'", async () => {
    // endsWith uses path-separator anchor, so 'evil-sandbox-builds' must not match.
    const evil = join(testRoot, "evil-sandbox-builds");
    mkdirSync(evil);
    await expect(sweepStaleBuilds(evil, 7)).rejects.toThrow(
      /must end in 'sandbox-builds'/,
    );
  });

  it("treats maxAgeDays=0 as 'remove everything'", async () => {
    createFile("a.vsk", 0);
    createFile("b.vsk", 5);
    const r = await sweepStaleBuilds(dir, 0);
    expect(r.scanned).toBe(2);
    expect(r.removed).toBe(2);
  });

  it("ignores symbolic links even when they end in .vsk", async () => {
    // Windows symlink creation typically requires Developer Mode or
    // admin elevation; skip there to keep the suite green on default CI.
    if (process.platform === "win32") return;

    const target = createFile("real-target.txt", 30);
    const linkPath = join(dir, "evil-link.vsk");
    symlinkSync(target, linkPath);
    const r = await sweepStaleBuilds(dir, 7);
    expect(r.removed).toBe(0);
    expect(existsSync(linkPath)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});
