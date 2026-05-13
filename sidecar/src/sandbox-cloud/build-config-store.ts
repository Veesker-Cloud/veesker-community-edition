import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface SandboxBuildConfig {
  sandboxId: string;
  connectionId: string;
  schemaName: string;
  primaryTables: Array<{ name: string; whereClause?: string; rowCap?: number }>;
  fkWalkDepth: number;
  piiLevel: 0 | 1 | 2;
  ttlDays: number;
  excludedPlsql?: Array<{ kind: string; owner: string; name: string }>;
  buildConfigVersion: 1;
}

const SUPPORTED_VERSION = 1 as const;

export async function saveBuildConfig(
  dir: string,
  config: SandboxBuildConfig,
): Promise<void> {
  const path = join(dir, `${config.sandboxId}.config.json`);
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

export async function loadBuildConfig(
  dir: string,
  sandboxId: string,
): Promise<SandboxBuildConfig | null> {
  const path = join(dir, `${sandboxId}.config.json`);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<SandboxBuildConfig>;
  if (parsed.buildConfigVersion !== SUPPORTED_VERSION) {
    throw new Error(
      `build-config-store: unsupported buildConfigVersion ${parsed.buildConfigVersion} (expected ${SUPPORTED_VERSION})`,
    );
  }
  return parsed as SandboxBuildConfig;
}
