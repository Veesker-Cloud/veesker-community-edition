// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { emitNotification } from "../src/notifications";

describe("emitNotification", () => {
  let captured: string[];
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    captured = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      captured.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as unknown as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test("writes a single newline-terminated frame", () => {
    emitNotification("foo.bar", { x: 1 });
    expect(captured.length).toBe(1);
    expect(captured[0].endsWith("\n")).toBe(true);
  });

  test("frame parses to {jsonrpc, method, params} with no id key", () => {
    emitNotification("ai.approval.request", { requestId: "r1", tool: "sql.exec" });
    const frame = captured[0];
    const parsed = JSON.parse(frame.trimEnd());
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("ai.approval.request");
    expect(parsed.params).toEqual({ requestId: "r1", tool: "sql.exec" });
    expect(Object.prototype.hasOwnProperty.call(parsed, "id")).toBe(false);
  });

  test("preserves null params verbatim", () => {
    emitNotification("ping", null);
    const parsed = JSON.parse(captured[0].trimEnd());
    expect(parsed.params).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsed, "id")).toBe(false);
  });
});
