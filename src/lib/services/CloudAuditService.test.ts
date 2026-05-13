// PROD-002 (audit 2026-04-30): test the metadata-only mode toggle based on
// connection.safety.env. Verifies that prod connections never upload SQL text.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core BEFORE importing the service.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.5-test" }));
// Force the cloudAudit feature flag on for the test.
vi.mock("./features", () => ({
  FEATURES: { cloudAudit: true, cloudAI: false, isLoggedIn: true },
}));

const { CloudAuditService } = await import("./CloudAuditService");

function basePush() {
  return {
    connectionId: "abc-123",
    connectionName: "test",
    host: "localhost",
    sql: "SELECT * FROM customers WHERE email = 'real@example.com'",
    success: true,
    rowCount: 1,
    elapsedMs: 5,
    errorCode: null,
    errorMessage: null,
  };
}

describe("CloudAuditService.push (PROD-002 mode toggle)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("uses metadata-only mode for env='prod'", async () => {
    // Push 50 entries to trigger flush.
    for (let i = 0; i < 50; i++) await CloudAuditService.push(basePush(), "prod");
    // Allow microtask queue to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(invokeMock).toHaveBeenCalled();
    const callArgs = invokeMock.mock.calls.find((c) => c[0] === "cloud_api_post");
    expect(callArgs).toBeDefined();
    const entries = (callArgs![1] as any).body.entries as any[];
    expect(entries.length).toBe(50);
    for (const e of entries) {
      expect(e.sqlMode).toBe("metadata-only");
      expect(e.sql).toBeNull();
      // sqlKind still derived even in metadata-only mode.
      expect(e.sqlKind).toBe("SELECT");
      // PII MUST NOT leak.
      expect(JSON.stringify(e)).not.toContain("real@example.com");
    }
  });

  it("uses full mode for env='dev'", async () => {
    for (let i = 0; i < 50; i++) await CloudAuditService.push(basePush(), "dev");
    await new Promise((r) => setTimeout(r, 10));
    const callArgs = invokeMock.mock.calls.find((c) => c[0] === "cloud_api_post");
    const entries = (callArgs![1] as any).body.entries as any[];
    for (const e of entries) {
      expect(e.sqlMode).toBe("full");
      expect(typeof e.sql).toBe("string");
      expect(e.sqlKind).toBe("SELECT");
    }
  });

  it("uses full mode when env is null (unspecified)", async () => {
    for (let i = 0; i < 50; i++) await CloudAuditService.push(basePush(), null);
    await new Promise((r) => setTimeout(r, 10));
    const callArgs = invokeMock.mock.calls.find((c) => c[0] === "cloud_api_post");
    const entries = (callArgs![1] as any).body.entries as any[];
    for (const e of entries) {
      expect(e.sqlMode).toBe("full");
      expect(typeof e.sql).toBe("string");
    }
  });

  it("metadata-only carries no SQL text even when SQL contains credentials", async () => {
    const credSql = `CREATE USER svc IDENTIFIED BY 'plaintext'`;
    const credPush = { ...basePush(), sql: credSql };
    for (let i = 0; i < 50; i++) await CloudAuditService.push(credPush, "prod");
    await new Promise((r) => setTimeout(r, 10));
    const callArgs = invokeMock.mock.calls.find((c) => c[0] === "cloud_api_post");
    const entries = (callArgs![1] as any).body.entries as any[];
    expect(JSON.stringify(entries)).not.toContain("plaintext");
    expect(JSON.stringify(entries)).not.toContain("IDENTIFIED");
  });
});
