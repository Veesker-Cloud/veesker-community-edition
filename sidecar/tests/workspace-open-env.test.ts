// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// Security item #1 — workspace.open must reject connections that have no env
// tag. This mirrors the exact handler logic from sidecar/src/index.ts so the
// contract stays in sync with production wiring.

import { describe, expect, test } from "bun:test";
import { dispatch, type HandlerMap } from "../src/handlers";
import { ENV_REQUIRED, RpcCodedError } from "../src/errors";

// Mock openSession — never calls Oracle. Returns a minimal success payload
// to confirm the env gate passed and openSession was reached.
async function mockOpenSession(_params: unknown): Promise<{ ok: boolean; sessionId: string }> {
  return { ok: true, sessionId: "mock-session" };
}

// Mirror of the production workspace.open guard in src/index.ts.
// Keep the logic here in sync with the production handler.
const handlers: HandlerMap = {
  "workspace.open": async (params) => {
    const envValue = (params as any)?.env;
    const validEnvs = ["dev", "staging", "prod", "local"];
    if (!envValue || !validEnvs.includes(envValue)) {
      throw new RpcCodedError(
        ENV_REQUIRED,
        "Connection has no environment tag. Set env to dev / staging / prod / local before connecting."
      );
    }
    return mockOpenSession(params);
  },
};

describe("workspace.open — env required gate (security item #1)", () => {
  test("ENV_REQUIRED is -32037", () => {
    expect(ENV_REQUIRED).toBe(-32037);
  });

  test("missing env throws -32037", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.open",
      params: { authType: "basic", host: "localhost", port: 1521, username: "hr", password: "hr" },
    });
    expect((res as any).error).toBeDefined();
    expect((res as any).error.code).toBe(ENV_REQUIRED);
    expect((res as any).error.code).toBe(-32037);
  });

  test("null params throws -32037", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 2,
      method: "workspace.open",
      params: null,
    });
    expect((res as any).error.code).toBe(ENV_REQUIRED);
  });

  test("empty string env throws -32037", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 3,
      method: "workspace.open",
      params: { env: "" },
    });
    expect((res as any).error.code).toBe(ENV_REQUIRED);
  });

  test("invalid env value 'production' throws -32037", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 4,
      method: "workspace.open",
      params: { env: "production" },
    });
    expect((res as any).error.code).toBe(ENV_REQUIRED);
  });

  test("invalid env value 'sandbox' throws -32037 (renamed to local)", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 5,
      method: "workspace.open",
      params: { env: "sandbox" },
    });
    expect((res as any).error.code).toBe(ENV_REQUIRED);
  });

  test("env=dev passes the gate and reaches openSession", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 6,
      method: "workspace.open",
      params: { env: "dev" },
    });
    expect((res as any).error).toBeUndefined();
    expect((res as any).result).toEqual({ ok: true, sessionId: "mock-session" });
  });

  test("env=staging passes the gate and reaches openSession", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 7,
      method: "workspace.open",
      params: { env: "staging" },
    });
    expect((res as any).error).toBeUndefined();
    expect((res as any).result).toEqual({ ok: true, sessionId: "mock-session" });
  });

  test("env=prod passes the gate and reaches openSession", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 8,
      method: "workspace.open",
      params: { env: "prod" },
    });
    expect((res as any).error).toBeUndefined();
    expect((res as any).result).toEqual({ ok: true, sessionId: "mock-session" });
  });

  test("env=local passes the gate and reaches openSession", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 9,
      method: "workspace.open",
      params: { env: "local" },
    });
    expect((res as any).error).toBeUndefined();
    expect((res as any).result).toEqual({ ok: true, sessionId: "mock-session" });
  });

  test("error message is descriptive and mentions valid options", async () => {
    const res = await dispatch(handlers, {
      jsonrpc: "2.0",
      id: 10,
      method: "workspace.open",
      params: { env: undefined },
    });
    const msg: string = (res as any).error.message;
    expect(msg).toContain("environment tag");
    expect(msg).toContain("local");
    expect(msg).toContain("prod");
  });
});

describe("store.rs — env_check_needs_local_update logic (pure TS mirror)", () => {
  // The Rust function checks if the sqlite_master sql string contains 'local'.
  // We mirror the logic here to verify the detection criterion is correct.
  function needsLocalUpdate(sql: string): boolean {
    return !sql.includes("'local'");
  }

  test("old schema without local returns true", () => {
    const oldSql = "CREATE TABLE connections ( env TEXT CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod')) )";
    expect(needsLocalUpdate(oldSql)).toBe(true);
  });

  test("schema with sandbox but not local returns true", () => {
    const sandboxSql = "CREATE TABLE connections ( env TEXT CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod', 'sandbox')) )";
    expect(needsLocalUpdate(sandboxSql)).toBe(true);
  });

  test("new schema with local returns false", () => {
    const newSql = "CREATE TABLE connections ( env TEXT CHECK (env IS NULL OR env IN ('dev', 'staging', 'prod', 'local')) )";
    expect(needsLocalUpdate(newSql)).toBe(false);
  });

  test("empty sql (table does not exist) returns true", () => {
    expect(needsLocalUpdate("")).toBe(true);
  });
});
