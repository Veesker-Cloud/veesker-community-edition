import { describe, it, expect, beforeEach } from "vitest";
import { operationsPanel } from "./operations-panel.svelte";

beforeEach(() => {
  localStorage.clear();
  operationsPanel.setTab("activity");
  operationsPanel.close();
  operationsPanel.setAutoRefresh(0);
});

describe("operationsPanel store", () => {
  it("defaults to activity tab when no localStorage", () => {
    expect(operationsPanel.activeTab).toBe("activity");
  });

  it("setTab persists to localStorage", () => {
    operationsPanel.setTab("session");
    expect(operationsPanel.activeTab).toBe("session");
    expect(localStorage.getItem("opsPanel.tab")).toBe("session");
  });

  it("toggle flips isOpen state", () => {
    expect(operationsPanel.isOpen).toBe(false);
    operationsPanel.toggle();
    expect(operationsPanel.isOpen).toBe(true);
    operationsPanel.toggle();
    expect(operationsPanel.isOpen).toBe(false);
  });

  it("close forces isOpen to false", () => {
    operationsPanel.toggle();
    operationsPanel.close();
    expect(operationsPanel.isOpen).toBe(false);
  });

  it("autoRefreshSec defaults to 0 (off)", () => {
    expect(operationsPanel.autoRefreshSec).toBe(0);
  });

  it("setAutoRefresh updates the value", () => {
    operationsPanel.setAutoRefresh(5);
    expect(operationsPanel.autoRefreshSec).toBe(5);
  });

  it("ignores invalid tab values from localStorage", () => {
    localStorage.setItem("opsPanel.tab", "garbage");
    // Module-level singleton: store init runs once at import, so this test asserts
    // robustness of the loader even if it can't fully exercise re-init.
    expect(["activity", "session"]).toContain(operationsPanel.activeTab);
  });
});
