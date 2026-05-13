// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import StatusBar from "./StatusBar.svelte";
import { sqlEditor } from "$lib/stores/sql-editor.svelte";
import type { WorkspaceSource } from "./sources/types";

vi.mock("svelte", async (importOriginal) => {
  const mod = await importOriginal<typeof import("svelte")>();
  return {
    ...mod,
    getContext: (key: unknown) => {
      if (key === "auth") return { tier: "ce", email: "" };
      return mod.getContext(key as never);
    },
  };
});

beforeEach(() => sqlEditor.reset());

const oracleSource = {
  meta: {
    id: "conn-1",
    kind: "oracle" as const,
    displayName: "Oracle Free",
    subtitle: "SYSTEM @ localhost:1521/FREEPDB1",
  },
  capabilities: {
    kinds: new Set(["TABLE"]) as ReadonlySet<never>,
    describeTables: true,
    runQueries: true,
    tabs: ["schema"] as ReadonlyArray<"schema" | "dashboard">,
  },
  open: async () => ({ ok: true as const }),
  close: async () => {},
  listSchemas: async () => [],
  listObjects: async () => [],
  describeTable: async () => ({ columns: [], indexes: [], rowCount: null, lastAnalyzed: null }),
  runQuery: async () => ({ columns: [], rows: [], rowCount: 0, durationMs: 0 }),
  loadDdl: async () => ({ kind: "unsupported" as const }),
  loadDataflow: async () => ({ kind: "unsupported" as const }),
} as unknown as WorkspaceSource;

const baseProps = {
  source: oracleSource,
  schema: "SYSTEM",
  serverVersion: "Oracle 23.26",
  onDisconnect: () => {},
  onSwitchConnection: () => {},
};

describe("StatusBar SQL toggle", () => {
  it("renders SQL toggle button", () => {
    render(StatusBar, { props: baseProps });
    expect(screen.getByRole("button", { name: /toggle sql drawer/i })).toBeInTheDocument();
  });

  it("clicking the toggle flips drawerOpen", async () => {
    render(StatusBar, { props: baseProps });
    const btn = screen.getByRole("button", { name: /toggle sql drawer/i });
    expect(sqlEditor.drawerOpen).toBe(false);
    await fireEvent.click(btn);
    expect(sqlEditor.drawerOpen).toBe(true);
  });

  it("toggle has active class when drawerOpen is true", async () => {
    render(StatusBar, { props: baseProps });
    const btn = screen.getByRole("button", { name: /toggle sql drawer/i });
    sqlEditor.toggleDrawer();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.className).toMatch(/active/);
  });
});
