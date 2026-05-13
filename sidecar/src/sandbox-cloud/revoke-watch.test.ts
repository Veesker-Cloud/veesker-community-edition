import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DuckDBHost } from "@veesker/engine";
import { clearAllSessions, registerSession, hasSession } from "./session";
import { startRevokeWatch } from "./revoke-watch";

let notifications: Array<{ method: string; params: any }>;
const dispatch = (n: { method: string; params: any }) => { notifications.push(n); };

beforeEach(async () => {
  notifications = [];
  await clearAllSessions();
});
afterEach(async () => {
  await clearAllSessions();
});

describe("startRevokeWatch", () => {
  it("emits sandbox.revoked + closes session when API returns 404", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-rev-1", { duckHost: host, tempPath: "/tmp/sb-rev-1.vsk", openedAt: 0 });

    const apiClient = {
      get: async () => {
        const e: any = new Error("not found");
        e.status = 404;
        throw e;
      },
    } as any;

    await startRevokeWatch({ sandboxId: "sb-rev-1", apiClient, dispatchNotification: dispatch });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe("sandbox.revoked");
    expect(notifications[0].params.sandbox_id).toBe("sb-rev-1");
    expect(notifications[0].params.reason).toBe("deleted");
    expect(hasSession("sb-rev-1")).toBe(false);
  });

  it("emits expired reason when status is expired", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-rev-2", { duckHost: host, tempPath: "/tmp/sb-rev-2.vsk", openedAt: 0 });

    const apiClient = {
      get: async () => ({ sandbox: { id: "sb-rev-2", status: "expired" } }),
    } as any;

    await startRevokeWatch({ sandboxId: "sb-rev-2", apiClient, dispatchNotification: dispatch });

    expect(notifications[0].params.reason).toBe("expired");
    expect(hasSession("sb-rev-2")).toBe(false);
  });

  it("does nothing when status is ready", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-rev-3", { duckHost: host, tempPath: "/tmp/sb-rev-3.vsk", openedAt: 0 });

    const apiClient = {
      get: async () => ({ sandbox: { id: "sb-rev-3", status: "ready" } }),
    } as any;

    await startRevokeWatch({ sandboxId: "sb-rev-3", apiClient, dispatchNotification: dispatch });

    expect(notifications).toHaveLength(0);
    expect(hasSession("sb-rev-3")).toBe(true);
    await host.close();
  });

  it("silently drops on 5xx / network error", async () => {
    const host = await DuckDBHost.openInMemory();
    registerSession("sb-rev-4", { duckHost: host, tempPath: "/tmp/sb-rev-4.vsk", openedAt: 0 });

    const apiClient = {
      get: async () => {
        const e: any = new Error("server error");
        e.status = 503;
        throw e;
      },
    } as any;

    await startRevokeWatch({ sandboxId: "sb-rev-4", apiClient, dispatchNotification: dispatch });

    expect(notifications).toHaveLength(0);
    expect(hasSession("sb-rev-4")).toBe(true);
    await host.close();
  });
});
