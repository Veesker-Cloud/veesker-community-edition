// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";
import GoingToSandboxList from "./GoingToSandboxList.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

function rowFor(container: HTMLElement, name: string): HTMLElement {
  const li = Array.from(container.querySelectorAll("li.row")).find((el) =>
    (el.textContent ?? "").includes(name),
  );
  if (!li) throw new Error(`row for ${name} not found`);
  return li as HTMLElement;
}

describe("GoingToSandboxList", () => {
  it("shows empty hint when no tables are picked", () => {
    const wizard = createPublishWizard();
    const { getByText } = render(GoingToSandboxList, { wizard });
    expect(getByText(/Pick a table on the left/)).toBeTruthy();
  });

  it("renders explicit, FK-pulled, and manual rows with distinct prefixes/badges", () => {
    const wizard = createPublishWizard();
    wizard.addExplicitTable("ORDERS");
    wizard.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        {
          name: "CUSTOMERS",
          depth: 1,
          viaFk: { fromTable: "ORDERS", fromColumns: ["CUSTOMER_ID"], toColumns: ["ID"] },
        },
      ],
      edges: [],
    });
    wizard.addManual("STATUS_CODES");
    const { container } = render(GoingToSandboxList, { wizard });

    const ordersRow = rowFor(container, "ORDERS");
    expect(ordersRow.textContent).toContain("★");
    expect(ordersRow.textContent?.toLowerCase()).toContain("explicit");

    const customersRow = rowFor(container, "CUSTOMERS");
    expect(customersRow.textContent).toContain("↳");
    expect(customersRow.textContent).toMatch(/FK·1/);

    const statusRow = rowFor(container, "STATUS_CODES");
    expect(statusRow.textContent).toContain("+");
    expect(statusRow.textContent?.toLowerCase()).toContain("manual");
  });

  it("clicking the × on an explicit row removes the table", async () => {
    const wizard = createPublishWizard();
    wizard.addExplicitTable("ORDERS");
    const { container, getByLabelText } = render(GoingToSandboxList, { wizard });
    expect(rowFor(container, "ORDERS")).toBeTruthy();
    await fireEvent.click(getByLabelText("Remove ORDERS"));
    expect(wizard.state.tables.explicit.length).toBe(0);
  });

  it("clicking the × on a FK row excludes it (E2E warning trigger)", async () => {
    const wizard = createPublishWizard();
    wizard.addExplicitTable("ORDERS");
    wizard.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        { name: "CUSTOMERS", depth: 1 },
      ],
      edges: [],
    });
    const { getByLabelText } = render(GoingToSandboxList, { wizard });
    await fireEvent.click(
      getByLabelText(/Exclude CUSTOMERS .*lose referential integrity/),
    );
    expect(wizard.state.tables.excluded.has("CUSTOMERS")).toBe(true);
    expect(wizard.hasE2eExclusionWarning()).toBe(true);
  });

  it("opening the cog popover surfaces the filter form", async () => {
    const wizard = createPublishWizard();
    wizard.addExplicitTable("ORDERS");
    const { getByLabelText, queryByPlaceholderText } = render(GoingToSandboxList, { wizard });
    expect(queryByPlaceholderText("created_at >= TRUNC(SYSDATE) - 30")).toBeNull();
    await fireEvent.click(getByLabelText("Filter rows for ORDERS"));
    expect(queryByPlaceholderText("created_at >= TRUNC(SYSDATE) - 30")).toBeTruthy();
  });
});
