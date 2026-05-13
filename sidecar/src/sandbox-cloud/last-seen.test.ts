import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLastSeenStore } from "./last-seen";

describe("createLastSeenStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "veesker-last-seen-"));
  });

  it("starts empty when file does not exist", async () => {
    const store = createLastSeenStore(join(dir, "missing.json"));
    expect(await store.loadLastSeenIds()).toEqual([]);
  });

  it("round-trips markSeen + load", async () => {
    const store = createLastSeenStore(join(dir, "seen.json"));
    await store.markSeen(["a", "b"]);
    expect((await store.loadLastSeenIds()).sort()).toEqual(["a", "b"]);
  });

  it("markSeen unions with existing without duplicates", async () => {
    const store = createLastSeenStore(join(dir, "union.json"));
    await store.markSeen(["a", "b"]);
    await store.markSeen(["b", "c"]);
    expect((await store.loadLastSeenIds()).sort()).toEqual(["a", "b", "c"]);
  });

  it("pruneStale drops ids not in the supplied list", async () => {
    const store = createLastSeenStore(join(dir, "prune.json"));
    await store.markSeen(["a", "b", "c"]);
    await store.pruneStale(["a", "c"]);
    expect((await store.loadLastSeenIds()).sort()).toEqual(["a", "c"]);
  });

  it("pruneStale on empty file is a no-op", async () => {
    const store = createLastSeenStore(join(dir, "empty.json"));
    await store.pruneStale(["a"]);
    expect(await store.loadLastSeenIds()).toEqual([]);
  });

  it("ignores corrupt JSON gracefully (returns empty)", async () => {
    const filePath = join(dir, "corrupt.json");
    await Bun.write(filePath, "not json at all{");
    const store = createLastSeenStore(filePath);
    expect(await store.loadLastSeenIds()).toEqual([]);
    await store.markSeen(["x"]);
    expect(await store.loadLastSeenIds()).toEqual(["x"]);
  });
});
