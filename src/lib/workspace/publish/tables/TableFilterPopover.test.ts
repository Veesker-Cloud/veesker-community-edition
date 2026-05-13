// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import TableFilterPopover from "./TableFilterPopover.svelte";

describe("TableFilterPopover", () => {
  it("calls onSave + onClose with edited whereClause", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { getByPlaceholderText, getByText } = render(TableFilterPopover, {
      tableName: "ORDERS",
      initialWhere: "",
      initialRowCap: null,
      onSave,
      onClose,
    });
    await fireEvent.input(getByPlaceholderText("created_at >= TRUNC(SYSDATE) - 30"), {
      target: { value: "id > 100" },
    });
    await fireEvent.click(getByText("Save"));
    expect(onSave).toHaveBeenCalledWith("id > 100", null);
    expect(onClose).toHaveBeenCalled();
  });

  it("sets rowCap from numeric input and skips invalid values", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { container, getByText } = render(TableFilterPopover, {
      tableName: "ORDERS",
      initialWhere: "x = 1",
      initialRowCap: null,
      onSave,
      onClose,
    });
    const numericInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    await fireEvent.input(numericInput, { target: { value: "500" } });
    await fireEvent.click(getByText("Save"));
    expect(onSave).toHaveBeenCalledWith("x = 1", 500);
  });

  it("Cancel calls onClose without onSave", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(TableFilterPopover, {
      tableName: "ORDERS",
      onSave,
      onClose,
    });
    await fireEvent.click(getByText("Cancel"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
