// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";
import SummaryPanel from "./SummaryPanel.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

describe("SummaryPanel", () => {
  it("shows ✓ E2E coherent when nothing excluded", () => {
    const w = createPublishWizard();
    w.addExplicitTable("ORDERS");
    const { getByText } = render(SummaryPanel, { wizard: w });
    expect(getByText("✓ Referential integrity preserved")).toBeTruthy();
  });

  it("shows ⚠ E2E warnings after excluding an FK-pulled table", () => {
    const w = createPublishWizard();
    w.addExplicitTable("ORDERS");
    w.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        { name: "CUSTOMERS", depth: 1 },
      ],
      edges: [],
    });
    w.excludeTable("CUSTOMERS");
    const { getByText } = render(SummaryPanel, { wizard: w });
    expect(getByText("⚠ Referential integrity warning")).toBeTruthy();
  });

  it("counts explicit, FK-by-depth, manual, and total", () => {
    const w = createPublishWizard();
    w.setSource("conn-1", "HR_DEV", { user: "u", password: "p", connectString: "h:1521/s" });
    w.addExplicitTable("ORDERS");
    w.addExplicitTable("INVOICES");
    w.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        { name: "INVOICES", depth: 0 },
        { name: "CUSTOMERS", depth: 1 },
        { name: "REGIONS", depth: 2 },
      ],
      edges: [],
    });
    w.addManual("LOOKUP");
    const { container } = render(SummaryPanel, { wizard: w });
    const text = container.textContent ?? "";
    expect(text).toContain("HR_DEV");
    expect(text).toMatch(/Explicit\s*2/);
    expect(text).toMatch(/Via FK \(1-hop\)\s*1/);
    expect(text).toMatch(/Via FK \(2-hop\)\s*1/);
    expect(text).toMatch(/Manual\s*1/);
    expect(text).toMatch(/Total\s*5/);
  });
});
