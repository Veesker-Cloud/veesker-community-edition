// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// L3.6 (Sprint C Onda 3) — Verify the ai.approval.resolve RPC dispatches to
// resolveApproval and surfaces -32036 for unknown requestIds. We mirror the
// exact handler shape from sidecar/src/index.ts so the contract stays in sync
// with production wiring.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { dispatch, type HandlerMap } from "../src/handlers";
import { APPROVAL_UNKNOWN_REQUEST_ID, RpcCodedError } from "../src/errors";
import {
  _resetApprovalsForTest,
  requestApproval,
  resolveApproval,
} from "../src/ai-approval-state";

const handlers: HandlerMap = {
  // Mirror of the production handler in src/index.ts. Keep in sync.
  "ai.approval.resolve": async (params: any) => {
    const requestId = String(params?.requestId ?? "");
    const approved = !!params?.approved;
    const applyToTurn = !!params?.applyToTurn;
    if (!requestId) {
      throw new RpcCodedError(APPROVAL_UNKNOWN_REQUEST_ID, "approval_unknown_request_id");
    }
    const found = resolveApproval(requestId, { approved, applyToTurn });
    if (!found) {
      throw new RpcCodedError(APPROVAL_UNKNOWN_REQUEST_ID, "approval_unknown_request_id");
    }
    return { ok: true };
  },
};

describe("ai.approval.resolve RPC", () => {
  // Silence the JSON-RPC notification frame requestApproval writes to stdout
  // so test output stays clean (the ai-approval-state tests already assert
  // the frame's contents).
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeSpy = spyOn(process.stdout, "write").mockImplementation(((
      _chunk: string | Uint8Array,
    ) => true) as unknown as typeof process.stdout.write);
    _resetApprovalsForTest();
  });

  afterEach(() => {
    writeSpy.mockRestore();
    _resetApprovalsForTest();
  });

  test("resolves the pending approval Promise with the supplied decision", async () => {
    const pending = requestApproval("rpc-1", "run_query", { sql: "SELECT 1" });

    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 1,
      method: "ai.approval.resolve",
      params: { requestId: "rpc-1", approved: true, applyToTurn: true },
    });

    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ approved: true, applyToTurn: true });
  });

  test("forwards approved=false / applyToTurn=false faithfully", async () => {
    const pending = requestApproval("rpc-2", "describe_object", { owner: "HR" });

    await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 2,
      method: "ai.approval.resolve",
      params: { requestId: "rpc-2", approved: false, applyToTurn: false },
    });

    await expect(pending).resolves.toEqual({ approved: false, applyToTurn: false });
  });

  test("unknown requestId throws -32036 (APPROVAL_UNKNOWN_REQUEST_ID)", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 3,
      method: "ai.approval.resolve",
      params: { requestId: "does-not-exist", approved: true, applyToTurn: false },
    });

    expect((res as any).error).toBeDefined();
    expect((res as any).error.code).toBe(APPROVAL_UNKNOWN_REQUEST_ID);
    expect((res as any).error.code).toBe(-32036);
    expect((res as any).error.message).toBe("approval_unknown_request_id");
  });

  test("missing/empty requestId also throws -32036", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 4,
      method: "ai.approval.resolve",
      params: { approved: true, applyToTurn: false },
    });

    expect((res as any).error.code).toBe(APPROVAL_UNKNOWN_REQUEST_ID);
  });

  test("a second resolve for the same requestId returns -32036 (already consumed)", async () => {
    const pending = requestApproval("rpc-5", "get_ddl", null);

    const first = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 5,
      method: "ai.approval.resolve",
      params: { requestId: "rpc-5", approved: true, applyToTurn: false },
    });
    expect((first as any).result).toEqual({ ok: true });
    await pending;

    const second = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 6,
      method: "ai.approval.resolve",
      params: { requestId: "rpc-5", approved: true, applyToTurn: false },
    });
    expect((second as any).error.code).toBe(APPROVAL_UNKNOWN_REQUEST_ID);
  });

  test("non-string requestId is coerced via String() and treated as unknown", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 7,
      method: "ai.approval.resolve",
      params: { requestId: 12345, approved: true, applyToTurn: false },
    });

    // 12345 was never registered, so the handler reports unknown.
    expect((res as any).error.code).toBe(APPROVAL_UNKNOWN_REQUEST_ID);
  });
});
