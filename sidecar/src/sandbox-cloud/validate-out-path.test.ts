import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateOutPath } from "./validate-out-path";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "veesker-validate-"));
  const anchor = join(root, "sandbox-builds");
  mkdirSync(anchor, { recursive: true });
  return { root, anchor };
}

describe("validateOutPath", () => {
  it("accepts a regular .vsk file directly under the anchor", async () => {
    const { root, anchor } = setup();
    try {
      const good = join(anchor, "sandbox-12345.vsk");
      writeFileSync(good, "stub");
      await expect(validateOutPath(good, anchor)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a path outside the anchor", async () => {
    const { root, anchor } = setup();
    try {
      const outside = join(root, "evil.vsk");
      writeFileSync(outside, "stub");
      await expect(validateOutPath(outside, anchor)).rejects.toThrow(
        /outside expected directory/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a relative-traversal path", async () => {
    const { root, anchor } = setup();
    try {
      const traversal = join(anchor, "..", "evil.vsk");
      writeFileSync(join(root, "evil.vsk"), "stub");
      await expect(validateOutPath(traversal, anchor)).rejects.toThrow(
        /outside expected directory/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a path without a .vsk extension", async () => {
    const { root, anchor } = setup();
    try {
      const wrongExt = join(anchor, "sandbox.txt");
      writeFileSync(wrongExt, "stub");
      await expect(validateOutPath(wrongExt, anchor)).rejects.toThrow(
        /must be a \.vsk file/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory even with .vsk suffix", async () => {
    const { root, anchor } = setup();
    try {
      const dir = join(anchor, "fake.vsk");
      mkdirSync(dir);
      await expect(validateOutPath(dir, anchor)).rejects.toThrow(
        /not a regular file/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects any symbolic link under the anchor",
    async () => {
      const { root, anchor } = setup();
      try {
        const target = join(root, "outside.vsk");
        writeFileSync(target, "stub");
        const link = join(anchor, "link.vsk");
        symlinkSync(target, link);
        await expect(validateOutPath(link, anchor)).rejects.toThrow(/symbolic link/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
