// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect } from "bun:test";
import { dispatch } from "./handlers";
import { RpcCodedError } from "./errors";

describe("dispatch", () => {
  it("forwards data field from RpcCodedError to JSON-RPC error response", async () => {
    const handlers = {
      "test.throws": () => {
        throw new RpcCodedError(-32033, "test", { kind: "missing_privilege", grant: "GRANT SELECT ON V_$SESSION TO <user>;" });
      },
    };

    const res = await dispatch(handlers as any, { jsonrpc: "2.0", id: 1, method: "test.throws", params: {} });

    expect(res.error?.code).toBe(-32033);
    expect(res.error?.message).toBe("test");
    expect(res.error?.data).toEqual({ kind: "missing_privilege", grant: "GRANT SELECT ON V_$SESSION TO <user>;" });
  });

  it("omits data when error has none", async () => {
    const handlers = {
      "test.basic": () => {
        throw new Error("boom");
      },
    };

    const res = await dispatch(handlers as any, { jsonrpc: "2.0", id: 2, method: "test.basic", params: {} });

    expect(res.error?.code).toBe(-32000);
    expect(res.error?.data).toBeUndefined();
  });
});
