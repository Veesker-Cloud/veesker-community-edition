// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import RecipientInput from "./RecipientInput.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

vi.mock("$lib/sandbox", () => ({
  lookupUserByEmail: vi.fn(),
}));

import { lookupUserByEmail } from "$lib/sandbox";

describe("RecipientInput", () => {
  it("on Enter, looks up email and adds chip with userId on 200", async () => {
    vi.mocked(lookupUserByEmail).mockResolvedValue({
      userId: "u-42",
      x25519Pubkey: "abc",
      registeredAt: "2026-05-02T00:00:00Z",
    });
    const w = createPublishWizard();
    const { getByPlaceholderText } = render(RecipientInput, { wizard: w });
    const input = getByPlaceholderText("email or user-id");
    await fireEvent.input(input, { target: { value: "bob@vsk.io" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.state.spec.recipients).toContainEqual(
      expect.objectContaining({
        email: "bob@vsk.io",
        userId: "u-42",
        pubkeyOk: true,
      }),
    );
  });

  it("on 404 (null), still adds chip but with pubkeyOk=false", async () => {
    vi.mocked(lookupUserByEmail).mockResolvedValue(null);
    const w = createPublishWizard();
    const { getByPlaceholderText } = render(RecipientInput, { wizard: w });
    const input = getByPlaceholderText("email or user-id");
    await fireEvent.input(input, { target: { value: "ghost@example.com" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.state.spec.recipients).toContainEqual(
      expect.objectContaining({
        email: "ghost@example.com",
        userId: null,
        pubkeyOk: false,
      }),
    );
  });

  it("trims + lowercases input before lookup", async () => {
    vi.mocked(lookupUserByEmail).mockResolvedValue(null);
    const w = createPublishWizard();
    const { getByPlaceholderText } = render(RecipientInput, { wizard: w });
    const input = getByPlaceholderText("email or user-id");
    await fireEvent.input(input, { target: { value: "  Alice@VSK.io  " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(lookupUserByEmail).toHaveBeenCalledWith("alice@vsk.io");
    expect(w.state.spec.recipients[0].email).toBe("alice@vsk.io");
  });

  it("dedupes — adding the same email twice keeps one chip", async () => {
    vi.mocked(lookupUserByEmail).mockResolvedValue(null);
    const w = createPublishWizard();
    const { getByPlaceholderText } = render(RecipientInput, { wizard: w });
    const input = getByPlaceholderText("email or user-id");
    await fireEvent.input(input, { target: { value: "bob@vsk.io" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    await fireEvent.input(input, { target: { value: "bob@vsk.io" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.state.spec.recipients.length).toBe(1);
  });

  it("surfaces errors when lookup throws", async () => {
    vi.mocked(lookupUserByEmail).mockRejectedValue(new Error("boom"));
    const w = createPublishWizard();
    const { getByPlaceholderText, findByText } = render(RecipientInput, { wizard: w });
    const input = getByPlaceholderText("email or user-id");
    await fireEvent.input(input, { target: { value: "bad@vsk.io" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(await findByText("boom")).toBeTruthy();
    expect(w.state.spec.recipients.length).toBe(0);
  });
});
