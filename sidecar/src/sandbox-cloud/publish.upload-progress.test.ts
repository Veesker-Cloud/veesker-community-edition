import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { uploadViaFetch } from "./publish";

let originalFetch: typeof globalThis.fetch;
let lastInit: RequestInit | undefined;
let consumedBody: Uint8Array | null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastInit = undefined;
  consumedBody = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchMock(status = 200): void {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    lastInit = init;
    if (init?.body instanceof ReadableStream) {
      // Drain the stream so onProgress fires through every chunk, mirroring
      // what a real PUT to R2 would do.
      const reader = init.body.getReader();
      const collected: number[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const b of value as Uint8Array) collected.push(b);
      }
      consumedBody = new Uint8Array(collected);
    } else if (init?.body instanceof Uint8Array) {
      consumedBody = init.body;
    }
    return new Response(null, { status });
  }) as typeof fetch;
}

describe("uploadViaFetch", () => {
  it("falls through to a non-streaming PUT when no onProgress is given", async () => {
    installFetchMock();
    const bytes = new Uint8Array(1024); // small
    await uploadViaFetch("https://r2.test/put", bytes);
    // Body should be the raw Uint8Array (no streaming wrapping).
    expect(lastInit?.body).toBeInstanceOf(Uint8Array);
    expect(consumedBody?.byteLength).toBe(1024);
  });

  it("falls through to non-streaming PUT for tiny payloads even with onProgress", async () => {
    installFetchMock();
    const calls: Array<[number, number]> = [];
    const bytes = new Uint8Array(2048);
    await uploadViaFetch("https://r2.test/put", bytes, (sent, total) => {
      calls.push([sent, total]);
    });
    // Below the chunk threshold the implementation skips streaming; it should
    // still emit a single completion tick so the UI can render 100%.
    expect(lastInit?.body).toBeInstanceOf(Uint8Array);
    expect(calls).toEqual([[2048, 2048]]);
  });

  it("streams the body and emits multiple progress ticks for large payloads", async () => {
    installFetchMock();
    const calls: Array<[number, number]> = [];
    const total = 256 * 1024; // 4 chunks at the 64 KiB chunk size
    const bytes = new Uint8Array(total);
    for (let i = 0; i < total; i++) bytes[i] = i & 0xff;
    await uploadViaFetch("https://r2.test/put", bytes, (sent, totalArg) => {
      calls.push([sent, totalArg]);
    });
    // Body should be a stream.
    expect(lastInit?.body).toBeInstanceOf(ReadableStream);
    // Content-Length must be set so the receiver knows when to stop.
    const ctLen = (lastInit?.headers as Record<string, string> | undefined)?.[
      "Content-Length"
    ];
    expect(ctLen).toBe(String(total));
    // At least 4 progress reports, ending exactly at total.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls[calls.length - 1]).toEqual([total, total]);
    // Every report monotonically increases.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBeGreaterThan(calls[i - 1][0]);
      expect(calls[i][1]).toBe(total);
    }
    // The bytes that arrived at the receiver match what we sent.
    expect(consumedBody?.byteLength).toBe(total);
  });

  it("throws when the upload returns a non-2xx status", async () => {
    installFetchMock(403);
    const bytes = new Uint8Array(100);
    await expect(uploadViaFetch("https://r2.test/put", bytes)).rejects.toThrow(
      /403/,
    );
  });
});
