import { describe, it, expect, beforeEach } from "bun:test";
import { ApiClient, ApiError } from "./client";

let lastRequest: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Promise<Response>;

const fetchSpy: typeof fetch = async (input, init) => {
  lastRequest = { url: String(input), init: init ?? {} };
  return await nextResponse();
};

describe("ApiClient", () => {
  beforeEach(() => {
    lastRequest = null;
  });

  it("attaches Authorization Bearer header", async () => {
    nextResponse = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    const c = new ApiClient({ baseUrl: "https://api.test", token: "tok-123", fetcher: fetchSpy });
    await c.get("/v1/sandboxes");
    expect((lastRequest!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("attaches Idempotency-Key when provided", async () => {
    nextResponse = async () => new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    const c = new ApiClient({ baseUrl: "https://api.test", token: "tok", fetcher: fetchSpy });
    await c.post("/v1/sandboxes", { name: "x" }, { idempotencyKey: "abc" });
    expect((lastRequest!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("abc");
  });

  it("retries 5xx up to maxRetries before throwing", async () => {
    let calls = 0;
    nextResponse = async () => {
      calls += 1;
      return new Response("err", { status: 503 });
    };
    const c = new ApiClient({ baseUrl: "https://api.test", token: "tok", fetcher: fetchSpy, maxRetries: 2, baseBackoffMs: 1 });
    await expect(c.get("/v1/sandboxes")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("does NOT retry 4xx", async () => {
    let calls = 0;
    nextResponse = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers: { "Content-Type": "application/json" } });
    };
    const c = new ApiClient({ baseUrl: "https://api.test", token: "tok", fetcher: fetchSpy, maxRetries: 5, baseBackoffMs: 1 });
    await expect(c.get("/v1/sandboxes")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  it("returns parsed JSON on 2xx", async () => {
    nextResponse = async () => new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    const c = new ApiClient({ baseUrl: "https://api.test", token: "tok", fetcher: fetchSpy });
    const j = await c.get<{ a: number }>("/v1/sandboxes");
    expect(j.a).toBe(1);
  });

  it("returns null on 204 No Content", async () => {
    nextResponse = async () => new Response(null, { status: 204 });
    const c = new ApiClient({ baseUrl: "https://api.test", token: "tok", fetcher: fetchSpy });
    const j = await c.delete("/v1/sandboxes/x");
    expect(j).toBeNull();
  });
});
