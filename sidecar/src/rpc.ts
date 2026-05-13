// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };

export function parseRequest(line: string): JsonRpcRequest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof obj !== "object" ||
    obj === null ||
    (obj as any).jsonrpc !== "2.0" ||
    typeof (obj as any).method !== "string" ||
    (typeof (obj as any).id !== "number" && typeof (obj as any).id !== "string")
  ) {
    return null;
  }
  return obj as JsonRpcRequest;
}

export function makeResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  const out: JsonRpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) out.params = params;
  return out;
}
