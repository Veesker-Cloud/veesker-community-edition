// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import SandboxCard from "./SandboxCard.svelte";
import type { SandboxSummary } from "$lib/sandbox";

const cachedSandbox: SandboxSummary = {
  sandbox_id: "sb-1", name: "orders_q3", owner_user_id: "owner@x.com",
  blob_size_bytes: 12_400_000, pulled_at: "2026-05-01T10:00:00Z",
  expires_at: new Date(Date.now() + 86400_000 * 2).toISOString(),
  status: "ready", cached: true, role: "owner",
};

const remoteSandbox: SandboxSummary = {
  ...cachedSandbox, sandbox_id: "sb-2", name: "analytics_demo",
  cached: false, pulled_at: undefined,
};

const memberSandbox: SandboxSummary = {
  ...cachedSandbox, sandbox_id: "sb-3", name: "shared_with_me", role: "member",
};

describe("SandboxCard", () => {
  it("renders sandbox name and meta", () => {
    render(SandboxCard, { props: { sandbox: cachedSandbox } });
    expect(screen.getByText("orders_q3")).toBeTruthy();
    expect(screen.getByText(/cached/i)).toBeTruthy();
  });

  it("clicking the card triggers onOpen for cached sandbox", async () => {
    const onOpen = vi.fn();
    render(SandboxCard, { props: { sandbox: cachedSandbox, onOpen } });
    const card = screen.getAllByRole("button")[0]!;
    await fireEvent.click(card);
    expect(onOpen).toHaveBeenCalled();
  });

  it("clicking the card triggers onPull for remote sandbox", async () => {
    const onPull = vi.fn();
    render(SandboxCard, { props: { sandbox: remoteSandbox, onPull } });
    const card = screen.getAllByRole("button")[0]; // first button is the card itself
    await fireEvent.click(card!);
    expect(onPull).toHaveBeenCalled();
  });

  it("does not trigger onOpen/onPull when isPulling=true", async () => {
    const onOpen = vi.fn();
    const onPull = vi.fn();
    render(SandboxCard, {
      props: { sandbox: remoteSandbox, onOpen, onPull, isPulling: true },
    });
    const card = screen.getAllByRole("button")[0];
    await fireEvent.click(card!);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
  });

  it("renders NEW pill on remote+isNew", () => {
    render(SandboxCard, { props: { sandbox: remoteSandbox, isNew: true } });
    expect(screen.getByText("NEW")).toBeTruthy();
  });

  it("does NOT render NEW pill for cached sandbox even if isNew=true", () => {
    render(SandboxCard, { props: { sandbox: cachedSandbox, isNew: true } });
    expect(screen.queryByText("NEW")).toBeNull();
  });

  it("owner role shows delete action", () => {
    render(SandboxCard, { props: { sandbox: cachedSandbox, onDelete: vi.fn() } });
    expect(screen.getByRole("button", { name: /delete orders_q3/i })).toBeTruthy();
  });

  it("member role shows leave action", () => {
    render(SandboxCard, { props: { sandbox: memberSandbox, onLeave: vi.fn() } });
    expect(screen.getByRole("button", { name: /leave shared_with_me/i })).toBeTruthy();
  });

  it("clicking delete opens confirm dialog (does not immediately delete)", async () => {
    const onDelete = vi.fn();
    render(SandboxCard, { props: { sandbox: cachedSandbox, onDelete } });
    await fireEvent.click(screen.getByRole("button", { name: /delete orders_q3/i }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("confirming delete invokes onDelete", async () => {
    const onDelete = vi.fn();
    render(SandboxCard, { props: { sandbox: cachedSandbox, onDelete } });
    await fireEvent.click(screen.getByRole("button", { name: /delete orders_q3/i }));
    await fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalled();
  });
});

describe("SandboxCard — Plan 7 republish (owner only)", () => {
  it("renders Republish button when role is owner and onRepublish provided", () => {
    const onRepublish = vi.fn();
    render(SandboxCard, { props: { sandbox: cachedSandbox, onRepublish } });
    const btn = screen.getByRole("button", { name: /republish orders_q3/i });
    expect(btn).toBeTruthy();
  });

  it("does NOT render republish button for member role", () => {
    const onRepublish = vi.fn();
    render(SandboxCard, { props: { sandbox: memberSandbox, onRepublish } });
    expect(screen.queryByRole("button", { name: /republish/i })).toBeNull();
  });

  it("does NOT render republish button when onRepublish prop is omitted (owner)", () => {
    render(SandboxCard, { props: { sandbox: cachedSandbox } });
    expect(screen.queryByRole("button", { name: /republish/i })).toBeNull();
  });

  it("opens an inline confirm row on click + cancel restores", async () => {
    const onRepublish = vi.fn();
    render(SandboxCard, { props: { sandbox: cachedSandbox, onRepublish } });
    const btn = screen.getByRole("button", { name: /republish orders_q3/i });
    await fireEvent.click(btn);
    expect(screen.getByText(/refresh data from the source/i)).toBeTruthy();
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    await fireEvent.click(cancel);
    expect(screen.queryByText(/refresh data from the source/i)).toBeNull();
    expect(onRepublish).not.toHaveBeenCalled();
  });

  it("calls onRepublish when confirm button is clicked", async () => {
    const onRepublish = vi.fn();
    render(SandboxCard, { props: { sandbox: cachedSandbox, onRepublish } });
    await fireEvent.click(screen.getByRole("button", { name: /republish orders_q3/i }));
    const buttons = screen.getAllByRole("button", { name: /republish/i });
    const confirm = buttons.find((b) => b.textContent?.trim().toLowerCase() === "republish");
    expect(confirm).toBeTruthy();
    await fireEvent.click(confirm!);
    expect(onRepublish).toHaveBeenCalledTimes(1);
  });
});

describe("SandboxCard — Plan 7 stale-version pill", () => {
  it("shows 🔄 New version pill when isStaleVersion is true", () => {
    render(SandboxCard, { props: { sandbox: memberSandbox, isStaleVersion: true } });
    expect(screen.getByText(/new version/i)).toBeTruthy();
  });

  it("does NOT show pill when isStaleVersion is false/omitted", () => {
    render(SandboxCard, { props: { sandbox: memberSandbox } });
    expect(screen.queryByText(/new version/i)).toBeNull();
  });
});
