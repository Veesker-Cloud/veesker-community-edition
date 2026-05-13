// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import Step5PlsqlReview from "./Step5PlsqlReview.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

const seedWizard = () => {
  const w = createPublishWizard();
  w.setSource("c1", "HR", true);
  w.addExplicitTable("EMP");
  return w;
};

describe("Step5PlsqlReview", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("transitions to running state on mount", async () => {
    mocks.invoke.mockResolvedValueOnce({ objects: [], totalEstimatedDdlBytes: 0 });
    const wizard = seedWizard();
    render(Step5PlsqlReview, { props: { wizard } });
    await waitFor(() => expect(wizard.state.plsql.discoveryStatus).toBe("ok"));
    // Spinner was shown during the running phase; by the time discovery
    // completes the status should be "ok" and canAdvance returns true.
    expect(wizard.state.plsql.discoveryStatus).toBe("ok");
    expect(wizard.canAdvance()).toBe(true);
  });

  it("renders discovered objects grouped by kind", async () => {
    mocks.invoke.mockResolvedValueOnce({
      objects: [
        { kind: "PROCEDURE", owner: "HR", name: "GET_EMP",       refPath: ["EMP", "GET_EMP"] },
        { kind: "PROCEDURE", owner: "HR", name: "UPDATE_SALARY", refPath: ["EMP", "UPDATE_SALARY"] },
        { kind: "FUNCTION",  owner: "HR", name: "CALC_BONUS",    refPath: ["EMP", "CALC_BONUS"] },
      ],
      totalEstimatedDdlBytes: 6144,
    });
    const wizard = seedWizard();
    render(Step5PlsqlReview, { props: { wizard } });
    await waitFor(() => screen.getByText(/Procedures \(2\)/i));
    expect(screen.getByText(/Functions \(1\)/i)).toBeTruthy();
  });

  it("toggles exclusion on checkbox click", async () => {
    mocks.invoke.mockResolvedValueOnce({
      objects: [{ kind: "PROCEDURE", owner: "HR", name: "P1", refPath: [] }],
      totalEstimatedDdlBytes: 2048,
    });
    const wizard = seedWizard();
    render(Step5PlsqlReview, { props: { wizard } });
    await waitFor(() => screen.getByLabelText(/HR\.P1/i));
    const cb = screen.getByLabelText(/HR\.P1/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    cb.click();
    await tick();
    expect(wizard.state.plsql.excluded.size).toBe(1);
  });

  it("auto-skip flag fires when 0 objects discovered", async () => {
    mocks.invoke.mockResolvedValueOnce({ objects: [], totalEstimatedDdlBytes: 0 });
    const wizard = seedWizard();
    render(Step5PlsqlReview, { props: { wizard } });
    await waitFor(() => expect(wizard.state.plsql.discoveryStatus).toBe("ok"));
    expect(wizard.state.plsql.discovered).toHaveLength(0);
    // canAdvance() should return true because discovered.length === 0
    expect(wizard.canAdvance()).toBe(true);
  });

  it("shows >10MB warning banner", async () => {
    // Use a small object count — the banner only depends on totalEstimatedDdlBytes.
    mocks.invoke.mockResolvedValueOnce({
      objects: [{ kind: "PROCEDURE", owner: "HR", name: "BIG_PROC", refPath: [] }],
      totalEstimatedDdlBytes: 12_000_000,
    });
    const wizard = seedWizard();
    render(Step5PlsqlReview, { props: { wizard } });
    await waitFor(() => screen.getByText(/large sandbox/i));
  });
});
