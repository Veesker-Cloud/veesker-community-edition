// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

// JSON-RPC 2.0 notification frames are requests without an `id` field.
// Per spec, notifications never receive a response from the peer.
export function emitNotification(method: string, params: unknown): void {
  const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
  process.stdout.write(frame + "\n");
}
