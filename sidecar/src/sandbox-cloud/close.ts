import { existsSync, unlinkSync } from "node:fs";
import { getSession, removeSession } from "./session";
import { _evictResultCache } from "./open";

export interface CloseSandboxParams {
  sandboxId: string;
}

export interface CloseSandboxResult {
  sandbox_id: string;
  status: "closed";
}

export async function closeSandbox(params: CloseSandboxParams): Promise<CloseSandboxResult> {
  const session = getSession(params.sandboxId);
  if (!session) {
    return { sandbox_id: params.sandboxId, status: "closed" };
  }
  try {
    await session.duckHost.close();
  } catch {
    /* best effort */
  }
  if (session.tempPath && existsSync(session.tempPath)) {
    try { unlinkSync(session.tempPath); } catch { /* best effort */ }
  }
  removeSession(params.sandboxId);
  _evictResultCache(params.sandboxId);
  return { sandbox_id: params.sandboxId, status: "closed" };
}
