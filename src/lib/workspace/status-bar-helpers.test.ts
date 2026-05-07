import { describe, it, expect } from "vitest";
import { shouldShowUserHost, txButtonState } from "./status-bar-helpers";

describe("shouldShowUserHost", () => {
  it("true when both username and serviceName non-empty", () => {
    expect(shouldShowUserHost("GIMBIAS", "PROD")).toBe(true);
  });
  it("false when username empty", () => {
    expect(shouldShowUserHost("", "PROD")).toBe(false);
  });
  it("false when serviceName empty", () => {
    expect(shouldShowUserHost("GIMBIAS", "")).toBe(false);
  });
  it("false when both undefined", () => {
    expect(shouldShowUserHost(undefined, undefined)).toBe(false);
  });
});

describe("txButtonState", () => {
  it("disabled when hasPendingTx is false", () => {
    expect(txButtonState(false).enabled).toBe(false);
    expect(txButtonState(false).ariaDisabled).toBe("true");
  });
  it("enabled when hasPendingTx is true", () => {
    expect(txButtonState(true).enabled).toBe(true);
    expect(txButtonState(true).ariaDisabled).toBe("false");
  });
});
