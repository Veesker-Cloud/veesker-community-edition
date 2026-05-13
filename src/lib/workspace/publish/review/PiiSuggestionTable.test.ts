// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";
import PiiSuggestionTable from "./PiiSuggestionTable.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

describe("PiiSuggestionTable", () => {
  it("renders empty hint when no suggestions", () => {
    const w = createPublishWizard();
    const { getByText } = render(PiiSuggestionTable, { wizard: w });
    expect(getByText(/No PII columns detected/)).toBeTruthy();
  });

  it("renders one row per suggestion with category + confidence", () => {
    const w = createPublishWizard();
    w.state.review.piiSuggestions = [
      {
        table: "CUST",
        column: "EMAIL",
        signal: "column-name",
        category: "email",
        suggestedMask: "HASH",
        confidence: 0.99,
      },
      {
        table: "CUST",
        column: "PHONE",
        signal: "both",
        category: "phone-br",
        suggestedMask: "FULL",
        confidence: 0.94,
      },
    ];
    const { getByText, container } = render(PiiSuggestionTable, { wizard: w });
    expect(getByText("CUST.EMAIL")).toBeTruthy();
    expect(getByText("CUST.PHONE")).toBeTruthy();
    expect(getByText("email")).toBeTruthy();
    expect(getByText("phone-br")).toBeTruthy();
    expect(container.textContent).toContain("0.99");
    expect(container.textContent).toContain("0.94");
  });

  it("changing a mask select records the override in the store", async () => {
    const w = createPublishWizard();
    w.state.review.piiSuggestions = [
      {
        table: "CUST",
        column: "EMAIL",
        signal: "column-name",
        category: "email",
        suggestedMask: "HASH",
        confidence: 0.99,
      },
    ];
    const { container } = render(PiiSuggestionTable, { wizard: w });
    const select = container.querySelector("select") as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "FULL" } });
    expect(w.state.review.piiOverrides.get("CUST.EMAIL")).toBe("FULL");
  });

  it("the suggested mask carries the ✓ marker in its option label", () => {
    const w = createPublishWizard();
    w.state.review.piiSuggestions = [
      {
        table: "CUST",
        column: "EMAIL",
        signal: "column-name",
        category: "email",
        suggestedMask: "HASH",
        confidence: 0.99,
      },
    ];
    const { container } = render(PiiSuggestionTable, { wizard: w });
    const hashOption = Array.from(container.querySelectorAll("option")).find(
      (o) => o.value === "HASH",
    );
    expect(hashOption?.textContent ?? "").toContain("✓");
  });
});
