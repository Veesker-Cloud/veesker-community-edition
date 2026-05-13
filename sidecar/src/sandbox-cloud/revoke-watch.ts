import { closeSandbox } from "./close";

export type RevokeReason = "deleted" | "expired" | "not_recipient";

export interface RevokeWatchParams {
  sandboxId: string;
  apiClient: { get: <T = unknown>(path: string) => Promise<T> };
  dispatchNotification: (n: { method: string; params: unknown }) => void;
}

interface ApiSandboxStatus {
  sandbox: { id: string; status: "ready" | "expired" | "deleted" };
}

export async function startRevokeWatch(params: RevokeWatchParams): Promise<void> {
  let resp: ApiSandboxStatus;
  try {
    resp = await params.apiClient.get<ApiSandboxStatus>(`/v1/sandboxes/${params.sandboxId}`);
  } catch (err: any) {
    if (err?.status === 404 || err?.status === 410) {
      await emitRevoke(params, "deleted");
    }
    // 4xx (other) and 5xx and network errors: silently drop
    return;
  }

  if (resp.sandbox.status === "expired") {
    await emitRevoke(params, "expired");
  } else if (resp.sandbox.status === "deleted") {
    await emitRevoke(params, "deleted");
  }
  // status === "ready" → no-op
}

async function emitRevoke(params: RevokeWatchParams, reason: RevokeReason): Promise<void> {
  params.dispatchNotification({
    method: "sandbox.revoked",
    params: { sandbox_id: params.sandboxId, reason },
  });
  await closeSandbox({ sandboxId: params.sandboxId });
}
