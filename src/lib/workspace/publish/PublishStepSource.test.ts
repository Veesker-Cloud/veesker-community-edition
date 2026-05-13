// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import PublishStepSource from "./PublishStepSource.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

vi.mock("$lib/connections", () => ({
  listConnections: vi.fn().mockResolvedValue({
    ok: true,
    data: [
      {
        authType: "basic",
        id: "conn-1",
        name: "HR_DEV",
        host: "localhost",
        port: 1521,
        serviceName: "FREEPDB1",
        username: "hr_owner",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        readOnly: false,
        warnUnsafeDml: false,
        autoPerfAnalysis: true,
      },
      {
        authType: "wallet",
        id: "conn-2",
        name: "PROD",
        connectAlias: "prod_high",
        username: "app",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        readOnly: true,
        warnUnsafeDml: true,
        autoPerfAnalysis: false,
      },
    ],
  }),
  sandboxOracleCheck: vi.fn(async (id: string) => {
    if (id === "conn-2") {
      return {
        ok: false,
        error: {
          code: -32602,
          message: "sandbox publish wizard does not support wallet connections yet",
        },
      };
    }
    return { ok: true, data: undefined };
  }),
}));

describe("PublishStepSource", () => {
  it("lists registered connections after mount", async () => {
    const wizard = createPublishWizard();
    const { findByText } = render(PublishStepSource, { wizard });
    expect(await findByText("HR_DEV")).toBeTruthy();
    expect(await findByText("PROD")).toBeTruthy();
  });

  it("clicking a basic connection sets source + flips credsReady true", async () => {
    const wizard = createPublishWizard();
    const { findByText } = render(PublishStepSource, { wizard });
    const row = await findByText("HR_DEV");
    await fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(wizard.state.source.connectionId).toBe("conn-1");
    expect(wizard.state.source.schemaName).toBe("HR_OWNER");
    expect(wizard.state.source.credsReady).toBe(true);
  });

  it("clicking a wallet connection sets source but leaves credsReady false with error", async () => {
    const wizard = createPublishWizard();
    const { findByText } = render(PublishStepSource, { wizard });
    const row = await findByText("PROD");
    await fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 0));
    expect(wizard.state.source.connectionId).toBe("conn-2");
    expect(wizard.state.source.schemaName).toBe("APP");
    expect(wizard.state.source.credsReady).toBe(false);
  });
});
