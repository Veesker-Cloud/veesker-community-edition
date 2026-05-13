import { readdir, lstat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface SweepResult {
  scanned: number;
  removed: number;
  errors: string[];
}

/**
 * Sanity-check the buildsDir before letting anything in this module touch
 * it. A compromised renderer that calls sandbox.sweep-builds with
 * `buildsDir = "C:\\Users\\foo"` and `maxAgeDays = 0` would otherwise wipe
 * every `.vsk` in the user's home directory. Require the path to end with
 * `sandbox-builds` (the Tauri shell's canonical app_data subdirectory) so
 * the renderer can only ask the sweep to operate on the directory it was
 * already supposed to. Tauri shell-injected paths satisfy this; other
 * paths throw.
 */
function assertBuildsDirShape(buildsDir: string): void {
  const resolved = resolve(buildsDir);
  const required = `${sep}sandbox-builds`;
  const requiredAlt = "/sandbox-builds"; // accept POSIX separator in tests
  if (
    !resolved.endsWith(required) &&
    !resolved.replace(/\\/g, "/").endsWith(requiredAlt)
  ) {
    throw new Error(
      `sweepStaleBuilds: refusing to sweep '${resolved}' — buildsDir must end in 'sandbox-builds'`,
    );
  }
}

/**
 * Remove `.vsk` files in `buildsDir` whose mtime is older than `maxAgeDays`.
 *
 * Targeted at `app_data/sandbox-builds/` — the directory the wizard writes
 * build artifacts to before publishing. The publish handler auto-deletes
 * its own `.vsk` on success (see handleSandboxPublish), so this sweep is
 * for the leftovers: aborted publishes, crashes, or anything that pre-dates
 * the auto-cleanup feature.
 *
 * The function is intentionally forgiving: if `buildsDir` does not exist
 * the result is `{ scanned: 0, removed: 0, errors: [] }` — there's nothing
 * to clean and that is not an error. Per-file failures (lstat, unlink) are
 * appended to `errors` instead of throwing, so a single locked file (EBUSY
 * on Windows) does not abort the whole sweep.
 *
 * Special case: `maxAgeDays === 0` means "purge every .vsk regardless of
 * age" and bypasses the mtime comparison entirely. Without this bypass, a
 * NTFS TOCTOU race can leave just-created files unswept: writeFileSync
 * resolves at T, then `Date.now()` (cutoff) is read at T+δ, but NTFS may
 * round the file's mtime up to a value ≥ T+δ — making `mtime > cutoff`
 * true and the file ineligible for removal. Callers passing 0 explicitly
 * mean "wipe all", so the cutoff check is irrelevant.
 */
export async function sweepStaleBuilds(
  buildsDir: string,
  maxAgeDays: number,
): Promise<SweepResult> {
  assertBuildsDirShape(buildsDir);
  const result: SweepResult = { scanned: 0, removed: 0, errors: [] };
  const cutoffMs = Date.now() - maxAgeDays * 86400_000;
  const purgeAll = maxAgeDays <= 0;

  let entries: string[];
  try {
    entries = await readdir(buildsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return result;
    }
    result.errors.push(
      `readdir failed: ${(err as Error).message ?? String(err)}`,
    );
    return result;
  }

  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".vsk")) continue;
    result.scanned += 1;
    const path = join(buildsDir, name);
    try {
      const st = await lstat(path);
      // Skip symlinks unconditionally: app_data/sandbox-builds/ should never
      // contain them legitimately, and following one out of the directory
      // would let an attacker who can write here turn the sweep into a
      // probe of mtime on arbitrary files (and `unlink` on a symlink only
      // removes the link anyway, so following it has no benefit).
      if (st.isSymbolicLink()) continue;
      if (!st.isFile()) continue;
      if (!purgeAll && st.mtimeMs > cutoffMs) continue;
      await unlink(path);
      result.removed += 1;
    } catch (err) {
      result.errors.push(`${name}: ${(err as Error).message ?? String(err)}`);
    }
  }

  return result;
}
