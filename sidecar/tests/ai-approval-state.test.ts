// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  _resetApprovalsForTest,
  requestApproval,
  resolveApproval,
  type ApprovalDecision,
} from "../src/ai-approval-state";

// We don't mock the notifications module (mock.module is global to the test
// runner and would leak into sibling test files). Instead we spy on
// process.stdout.write — emitNotification's only side effect — and parse the
// captured frames to assert on what was sent.

describe("ai-approval-state", () => {
  let stdoutFrames: string[];
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutFrames = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdoutFrames.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as unknown as typeof process.stdout.write);
    _resetApprovalsForTest();
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test("requestApproval then resolveApproval resolves with the decision", async () => {
    const promise = requestApproval("req-1", "sql.exec", { sql: "SELECT 1" });
    const decision: ApprovalDecision = { approved: true, applyToTurn: false };
    const found = resolveApproval("req-1", decision);
    expect(found).toBe(true);
    await expect(promise).resolves.toEqual(decision);
  });

  test("resolveApproval for unknown requestId returns false", () => {
    expect(resolveApproval("nope", { approved: true, applyToTurn: false })).toBe(false);
  });

  test("resolveApproval called twice returns true then false", async () => {
    const promise = requestApproval("req-2", "sql.exec", null);
    const first = resolveApproval("req-2", { approved: true, applyToTurn: true });
    const second = resolveApproval("req-2", { approved: false, applyToTurn: false });
    expect(first).toBe(true);
    expect(second).toBe(false);
    await expect(promise).resolves.toEqual({ approved: true, applyToTurn: true });
  });

  test("requestApproval emits exactly one ai.approval.request notification", async () => {
    const promise = requestApproval("req-3", "shell.run", { cmd: "ls" });
    expect(stdoutFrames.length).toBe(1);
    const parsed = JSON.parse(stdoutFrames[0].trimEnd());
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("ai.approval.request");
    expect(parsed.params).toEqual({
      requestId: "req-3",
      tool: "shell.run",
      input: { cmd: "ls" },
    });
    expect(Object.prototype.hasOwnProperty.call(parsed, "id")).toBe(false);
    // Drain the pending promise so the test doesn't leave dangling state.
    resolveApproval("req-3", { approved: false, applyToTurn: false });
    await promise;
  });

  test("timeout fires auto-deny and cleans up the registry", async () => {
    // Inject a tiny timeout instead of relying on fake timers — bun:test
    // does not ship a fake-timer API at parity with vi.useFakeTimers().
    const promise = requestApproval("req-4", "sql.exec", { sql: "DROP TABLE x" }, 5);
    await expect(promise).resolves.toEqual({ approved: false, applyToTurn: false });
    // After timeout the entry is gone — a follow-up resolve must report unknown.
    expect(resolveApproval("req-4", { approved: true, applyToTurn: false })).toBe(false);
  });

  test("late timeout after manual resolve is a noop", async () => {
    const promise = requestApproval("req-5", "sql.exec", null, 20);
    const found = resolveApproval("req-5", { approved: true, applyToTurn: false });
    expect(found).toBe(true);
    await expect(promise).resolves.toEqual({ approved: true, applyToTurn: false });
    // Wait past the original timeout and confirm nothing else fires / no
    // exceptions surface (the cleared timer or the pending.has guard inside
    // requestApproval prevents a stale resolve).
    await new Promise((r) => setTimeout(r, 40));
    expect(resolveApproval("req-5", { approved: false, applyToTurn: false })).toBe(false);
  });
});
