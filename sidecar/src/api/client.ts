export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetcher?: typeof fetch;
  maxRetries?: number;
  baseBackoffMs?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public bodyJson: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private baseUrl: string;
  private token: string;
  private fetcher: typeof fetch;
  private maxRetries: number;
  private baseBackoffMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetcher = opts.fetcher ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 250;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return await this.request("GET", path) as T;
  }

  async post<T = unknown>(path: string, body: unknown, opts?: { idempotencyKey?: string }): Promise<T> {
    return await this.request("POST", path, body, opts) as T;
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    return await this.request("PUT", path, body) as T;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return await this.request("DELETE", path) as T;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetcher(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status >= 200 && res.status < 300) {
        if (res.status === 204) return null;
        const ct = res.headers.get("Content-Type") ?? "";
        if (ct.includes("application/json")) return await res.json();
        return await res.text();
      }
      // 4xx is final
      if (res.status >= 400 && res.status < 500) {
        const j = await res.json().catch(() => null);
        throw new ApiError(res.status, j, `${method} ${path} → ${res.status}`);
      }
      // 5xx → retry with backoff
      lastErr = new ApiError(res.status, await res.json().catch(() => null), `${method} ${path} → ${res.status}`);
      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, this.baseBackoffMs * Math.pow(2, attempt)));
      }
    }
    throw lastErr ?? new Error(`${method} ${path} failed`);
  }
}
