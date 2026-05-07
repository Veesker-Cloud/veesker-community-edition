import { describe, it, expect } from "vitest";
import { mapSessionError, formatLogonAge, semanticColorFor } from "./session-tab-helpers";

describe("mapSessionError", () => {
  it("returns missing_privilege for kind missing_privilege", () => {
    const err = { code: -32033, data: { kind: "missing_privilege", grant: "GRANT..." } };
    expect(mapSessionError(err).kind).toBe("missing_privilege");
  });

  it("returns transient for unknown errors", () => {
    expect(mapSessionError(new Error("boom")).kind).toBe("transient");
  });

  it("returns transient when no .code", () => {
    expect(mapSessionError({}).kind).toBe("transient");
  });

  it("forwards oracleCode and message for transient errors with data", () => {
    const err = { code: -32034, data: { kind: "transient", oracleCode: 942 }, message: "ORA-00942: table or view does not exist" };
    const m = mapSessionError(err);
    expect(m.kind).toBe("transient");
    expect(m.oracleCode).toBe(942);
    expect(m.message).toBe("ORA-00942: table or view does not exist");
  });

  it("returns transient when err is null", () => {
    expect(mapSessionError(null).kind).toBe("transient");
  });

  it("returns transient when err is a primitive string", () => {
    expect(mapSessionError("plain string error").kind).toBe("transient");
  });
});

describe("formatLogonAge", () => {
  it("formats seconds when < 60s", () => {
    const now = new Date("2026-05-06T10:00:30").getTime();
    expect(formatLogonAge("2026-05-06T10:00:00", now)).toBe("30s ago");
  });

  it("formats minutes when < 1h", () => {
    const now = new Date("2026-05-06T10:32:00").getTime();
    expect(formatLogonAge("2026-05-06T10:00:00", now)).toBe("32m ago");
  });

  it("formats hours when >= 1h", () => {
    const now = new Date("2026-05-06T13:00:00").getTime();
    expect(formatLogonAge("2026-05-06T10:00:00", now)).toBe("3h ago");
  });

  it("formats exactly 60s as 1m ago (boundary)", () => {
    const now = new Date("2026-05-06T10:01:00").getTime();
    expect(formatLogonAge("2026-05-06T10:00:00", now)).toBe("1m ago");
  });

  it("formats exactly 3600s as 1h ago (boundary)", () => {
    const now = new Date("2026-05-06T11:00:00").getTime();
    expect(formatLogonAge("2026-05-06T10:00:00", now)).toBe("1h ago");
  });
});

describe("semanticColorFor", () => {
  it("highlights ACTIVE status as green-ish", () => {
    expect(semanticColorFor("STATUS", "ACTIVE")).toBe("var(--vsk-status-ok)");
  });
  it("highlights WAITING state as yellow", () => {
    expect(semanticColorFor("STATE", "WAITING")).toBe("var(--vsk-status-warn)");
  });
  it("returns default for unknown fields", () => {
    expect(semanticColorFor("UNKNOWN", "anything")).toBe("var(--vsk-fg-muted)");
  });
});
