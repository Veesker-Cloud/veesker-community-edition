import { lstat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export async function validateOutPath(
  outPath: string,
  expectedBuildsDir: string,
): Promise<void> {
  const resolvedPath = resolve(outPath);
  const resolvedAnchor = resolve(expectedBuildsDir);

  if (!resolvedPath.startsWith(resolvedAnchor + sep)) {
    throw new Error("validate-out-path: outPath outside expected directory");
  }
  if (!resolvedPath.toLowerCase().endsWith(".vsk")) {
    throw new Error("validate-out-path: outPath must be a .vsk file");
  }

  let stat;
  try {
    stat = await lstat(resolvedPath);
  } catch (err) {
    throw new Error(
      `validate-out-path: cannot stat outPath: ${(err as Error).message}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      "validate-out-path: outPath is a symbolic link (refusing to follow)",
    );
  }
  if (!stat.isFile()) {
    throw new Error("validate-out-path: outPath is not a regular file");
  }
}
