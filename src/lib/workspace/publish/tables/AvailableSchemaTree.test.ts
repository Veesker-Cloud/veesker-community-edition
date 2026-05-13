// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import AvailableSchemaTree from "./AvailableSchemaTree.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

vi.mock("$lib/sandbox", () => ({
  listSchemaTables: vi.fn().mockResolvedValue({
    tables: [
      { name: "ORDERS", rowCount: 1000, sizeBytesEst: 100_000 },
      { name: "CUSTOMERS", rowCount: 500, sizeBytesEst: 50_000 },
    ],
  }),
}));

describe("AvailableSchemaTree", () => {
  it("loads tables on mount and renders them, caching into wizard.tables.available", async () => {
    const wizard = createPublishWizard();
    wizard.setSource("conn-1", "HR_DEV", true);
    const { findByText } = render(AvailableSchemaTree, { wizard });
    expect(await findByText("ORDERS")).toBeTruthy();
    expect(await findByText("CUSTOMERS")).toBeTruthy();
    expect(wizard.state.tables.available.map((t) => t.name)).toEqual([
      "ORDERS",
      "CUSTOMERS",
    ]);
  });

  it("checking a row adds the table as explicit (uppercase)", async () => {
    const wizard = createPublishWizard();
    wizard.setSource("conn-1", "HR_DEV", true);
    const { findByLabelText } = render(AvailableSchemaTree, { wizard });
    const checkbox = await findByLabelText("ORDERS");
    await fireEvent.click(checkbox);
    expect(wizard.state.tables.explicit.map((t) => t.name)).toContain("ORDERS");
  });

  it("unchecking a row removes the table from explicit", async () => {
    const wizard = createPublishWizard();
    wizard.setSource("conn-1", "HR_DEV", true);
    wizard.addExplicitTable("ORDERS");
    const { findByLabelText } = render(AvailableSchemaTree, { wizard });
    const checkbox = await findByLabelText("ORDERS");
    await fireEvent.click(checkbox);
    expect(wizard.state.tables.explicit.map((t) => t.name)).not.toContain("ORDERS");
  });

  it("search filters tables case-insensitively", async () => {
    const wizard = createPublishWizard();
    wizard.setSource("conn-1", "HR_DEV", true);
    const { findByPlaceholderText, queryByText, findByText } = render(
      AvailableSchemaTree,
      { wizard },
    );
    await findByText("ORDERS");
    const input = await findByPlaceholderText("Search tables...");
    await fireEvent.input(input, { target: { value: "cust" } });
    expect(queryByText("ORDERS")).toBeNull();
    expect(queryByText("CUSTOMERS")).toBeTruthy();
  });

  it("does not call listSchemaTables before a source is set", async () => {
    const sandbox = await import("$lib/sandbox");
    vi.mocked(sandbox.listSchemaTables).mockClear();
    const wizard = createPublishWizard();
    render(AvailableSchemaTree, { wizard });
    await new Promise((r) => setTimeout(r, 0));
    expect(sandbox.listSchemaTables).not.toHaveBeenCalled();
  });
});
