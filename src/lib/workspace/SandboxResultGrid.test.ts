// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SandboxResultGrid from "./SandboxResultGrid.svelte";

describe("SandboxResultGrid", () => {
  it("renders columns and rows", () => {
    render(SandboxResultGrid, { props: {
      columns: [{ name: "id", type: "INTEGER" }, { name: "name", type: "VARCHAR" }],
      rows: [[1, "Alice"], [2, "Bob"]],
      row_count: 2,
      elapsed_ms: 5,
    } });
    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("renders NULL placeholder for null cells", () => {
    render(SandboxResultGrid, { props: {
      columns: [{ name: "x", type: "INTEGER" }],
      rows: [[null]],
      row_count: 1,
      elapsed_ms: 0,
    } });
    expect(screen.getByText("<NULL>")).toBeTruthy();
  });

  it("renders empty state when no rows", () => {
    render(SandboxResultGrid, { props: {
      columns: [],
      rows: [],
      row_count: 0,
      elapsed_ms: 0,
    } });
    expect(screen.getByText(/no results/i)).toBeTruthy();
  });

  it("formats bigint values", () => {
    render(SandboxResultGrid, { props: {
      columns: [{ name: "n", type: "BIGINT" }],
      rows: [[BigInt(123456)]],
      row_count: 1,
      elapsed_ms: 0,
    } });
    expect(screen.getByText("123456")).toBeTruthy();
  });
});
