import type { DuckDBHost } from "@veesker/engine";

export interface OpenSession {
  duckHost: DuckDBHost;
  tempPath: string;
  openedAt: number;
}

const sessions = new Map<string, OpenSession>();

export function registerSession(sandboxId: string, session: OpenSession): void {
  sessions.set(sandboxId, session);
}

export function getSession(sandboxId: string): OpenSession | undefined {
  return sessions.get(sandboxId);
}

export function hasSession(sandboxId: string): boolean {
  return sessions.has(sandboxId);
}

export function removeSession(sandboxId: string): void {
  sessions.delete(sandboxId);
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export async function clearAllSessions(): Promise<void> {
  const all = Array.from(sessions.values());
  sessions.clear();
  for (const s of all) {
    try { await s.duckHost.close(); } catch { /* best effort */ }
  }
}
