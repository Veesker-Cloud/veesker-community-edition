// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// L3.3 — Verify the oracle.session_dbms_output_enable RPC dispatches to
// enableDbmsOutputForActiveSession, and that the workspace.open wrapper
// invokes the same enable function after a successful open. We mirror the
// exact handler shape from sidecar/src/index.ts so the contract stays in sync.

import { describe, expect, test, mock } from "bun:test";
import { dispatch, type HandlerMap } from "../src/handlers";

describe("oracle.session_dbms_output_enable RPC", () => {
  test("calls enableDbmsOutputForActiveSession and returns { ok: true }", async () => {
    const enable = mock(async () => {});
    const handlers: HandlerMap = {
      "oracle.session_dbms_output_enable": async () => {
        await enable();
        return { ok: true };
      },
    };
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 1,
      method: "oracle.session_dbms_output_enable",
      params: {},
    });
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe("workspace.open invokes DBMS_OUTPUT enable on success", () => {
  test("calls enable after openSession resolves", async () => {
    const enable = mock(async () => {});
    const open = mock(async () => ({
      serverVersion: "Oracle 23ai",
      currentSchema: "SCOTT",
      user: "SCOTT",
      serviceName: "FREEPDB1",
    }));
    const handlers: HandlerMap = {
      "workspace.open": async (params) => {
        const r = await open(params);
        await enable();
        return r;
      },
    };
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.open",
      params: { username: "SCOTT", password: "tiger" },
    });
    expect((res as any).result.user).toBe("SCOTT");
    expect(open).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledTimes(1);
  });

  test("does NOT call enable when openSession rejects", async () => {
    const enable = mock(async () => {});
    const open = mock(async () => {
      throw new Error("ORA-12541: TNS:no listener");
    });
    const handlers: HandlerMap = {
      "workspace.open": async (params) => {
        const r = await open(params);
        await enable();
        return r;
      },
    };
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.open",
      params: {},
    });
    expect((res as any).error).toBeDefined();
    expect(enable).not.toHaveBeenCalled();
  });
});
