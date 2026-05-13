// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  ensureSandboxKeypair,
  listSandboxes,
  pullSandbox,
  openSandbox,
  querySandbox,
  closeSandbox,
  listSchemaTables,
  computeFkClosure,
  buildSandboxDryRun,
  lookupUserByEmail,
  publishSandbox,
} from "./sandbox";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("sandbox lib", () => {
  it("ensureSandboxKeypair invokes Tauri command and returns shape", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return {
        pubkey_b64: "abc==",
        registered_at: "2026-05-01T00:00:00Z",
        just_registered: true,
      };
    });
    const out = await ensureSandboxKeypair();
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_ensure_keypair",
      expect.objectContaining({ payload: expect.any(Object) }),
    );
    expect(out.just_registered).toBe(true);
  });

  it("pullSandbox passes sandboxId in envelope", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return {
        sandbox_id: "sb-1",
        cached: true,
        name: "x",
        status: "ready",
        blob_size_bytes: 100,
        pulled_at: "now",
      };
    });
    await pullSandbox("sb-1");
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_pull",
      expect.objectContaining({
        payload: expect.objectContaining({ sandboxId: "sb-1" }),
      }),
    );
  });

  it("openSandbox returns tables + columns", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return {
        sandbox_id: "sb-1",
        tables: ["t"],
        columns: [{ table_name: "t", name: "a", type: "INTEGER", nullable: true }],
        opened_at: "now",
        status: "open",
      };
    });
    const r = await openSandbox("sb-1");
    expect(r.tables).toEqual(["t"]);
  });

  it("querySandbox passes sandboxId + sql in envelope", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return { columns: [], rows: [], row_count: 0, elapsed_ms: 1 };
    });
    await querySandbox("sb-1", "SELECT 1");
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_query",
      expect.objectContaining({
        payload: expect.objectContaining({ sandboxId: "sb-1", sql: "SELECT 1" }),
      }),
    );
  });

  it("closeSandbox returns closed status", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return { sandbox_id: "sb-1", status: "closed" };
    });
    const r = await closeSandbox("sb-1");
    expect(r.status).toBe("closed");
  });

  it("listSandboxes calls list-cached then merges remote", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      if (cmd === "sandbox_list_cached") {
        return {
          sandboxes: [
            {
              sandbox_id: "a",
              name: "a",
              owner_user_id: "o",
              blob_size_bytes: 1,
              pulled_at: "now",
              expires_at: "soon",
            },
          ],
        };
      }
      if (cmd === "sandbox_list") {
        return {
          sandboxes: [
            {
              id: "a",
              name: "a",
              status: "ready",
              role: "owner",
              expires_at: "soon",
              created_at: "old",
              finalized_at: null,
              blob_size_bytes: 1,
            },
            {
              id: "b",
              name: "b",
              status: "ready",
              role: "member",
              expires_at: "soon",
              created_at: "old",
              finalized_at: null,
              blob_size_bytes: 2,
            },
          ],
        };
      }
      throw new Error("unexpected");
    });
    const { cached, remote } = await listSandboxes();
    expect(cached.map((c) => c.sandbox_id)).toEqual(["a"]);
    expect(remote.map((r) => r.sandbox_id)).toEqual(["b"]);
    expect(remote.find((r) => r.sandbox_id === "a")).toBeUndefined();
    expect(cached.find((c) => c.sandbox_id === "a")?.cached).toBe(true);
  });

  it("listSchemaTables forwards connectionId+schemaName (Rust resolves credentials)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return {
        tables: [
          { name: "ORDERS", rowCount: 100, sizeBytesEst: 4096 },
          { name: "ORDER_ITEMS", rowCount: 500, sizeBytesEst: 8192 },
        ],
      };
    });
    const out = await listSchemaTables("conn-1", "ORDERS_OWNER");
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_list_schema_tables",
      expect.objectContaining({
        payload: expect.objectContaining({
          connectionId: "conn-1",
          schemaName: "ORDERS_OWNER",
        }),
      }),
    );
    // Renderer must NOT carry oracleConfig — credentials live only in Rust.
    const callArgs = vi.mocked(invoke).mock.calls.find(
      ([cmd]) => cmd === "sandbox_list_schema_tables",
    );
    expect(callArgs?.[1]).toBeDefined();
    const payload = (callArgs![1] as { payload: Record<string, unknown> }).payload;
    expect(payload.oracleConfig).toBeUndefined();
    expect(out.tables.map((t) => t.name)).toEqual(["ORDERS", "ORDER_ITEMS"]);
  });

  it("computeFkClosure forwards primaryTables+fkDepth without oracleConfig", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return {
        entries: [
          { name: "ORDERS", depth: 0 },
          {
            name: "CUSTOMERS",
            depth: 1,
            viaFk: { fromTable: "ORDERS", fromColumns: ["CUSTOMER_ID"], toColumns: ["ID"] },
          },
        ],
        edges: [
          {
            fromTable: "ORDERS",
            fromColumns: ["CUSTOMER_ID"],
            toTable: "CUSTOMERS",
            toColumns: ["ID"],
          },
        ],
      };
    });
    const out = await computeFkClosure("conn-1", "ORDERS_OWNER", ["ORDERS"], 2);
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_compute_fk_closure",
      expect.objectContaining({
        payload: expect.objectContaining({
          connectionId: "conn-1",
          schemaName: "ORDERS_OWNER",
          primaryTables: ["ORDERS"],
          fkDepth: 2,
        }),
      }),
    );
    const callArgs = vi.mocked(invoke).mock.calls.find(
      ([cmd]) => cmd === "sandbox_compute_fk_closure",
    );
    const payload = (callArgs![1] as { payload: Record<string, unknown> }).payload;
    expect(payload.oracleConfig).toBeUndefined();
    expect(out.entries).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
  });

  it("buildSandboxDryRun forces dryRun:true in the spec and omits oracleConfig", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return {
        result: {
          outPath: "",
          totalRows: 0,
          tableCount: 0,
          piiSuggestionsApplied: 0,
          ttlExpiresAt: "2026-06-01T00:00:00Z",
        },
        events: [
          {
            phase: "dry-run-done",
            fkClosureTables: ["ORDERS"],
            piiSuggestions: [],
            estimatedSizeBytes: 1024,
            estimatedTotalRows: 100,
          },
        ],
      };
    });
    const spec = {
      connectionId: "conn-1",
      schemaName: "ORDERS_OWNER",
      sandboxName: "demo",
      ttlDays: 7,
      piiLevel: 1 as const,
      primaryTables: [{ name: "ORDERS" }],
      fkWalkDepth: 2,
    };
    await buildSandboxDryRun(spec);
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_build_dry_run",
      expect.objectContaining({
        payload: expect.objectContaining({
          connectionId: "conn-1",
          spec: expect.objectContaining({
            connectionId: "conn-1",
            schemaName: "ORDERS_OWNER",
            sandboxName: "demo",
            ttlDays: 7,
            piiLevel: 1,
            primaryTables: [{ name: "ORDERS" }],
            fkWalkDepth: 2,
            dryRun: true,
          }),
        }),
      }),
    );
    const callArgs = vi.mocked(invoke).mock.calls.find(
      ([cmd]) => cmd === "sandbox_build_dry_run",
    );
    const payload = (callArgs![1] as { payload: Record<string, unknown> }).payload;
    expect(payload.oracleConfig).toBeUndefined();
  });

  it("lookupUserByEmail returns parsed body on 200", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return "tok";
      throw new Error("unexpected");
    });
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        user_id: "u-1",
        x25519_pubkey: "AAAA==",
        registered_at: "2026-04-30T00:00:00Z",
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await lookupUserByEmail("alice@example.com");
      expect(r).toEqual({
        userId: "u-1",
        x25519Pubkey: "AAAA==",
        registeredAt: "2026-04-30T00:00:00Z",
      });
      const callArg = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
      expect(callArg).toMatch(/\/v1\/users\/lookup\?email=alice%40example\.com$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lookupUserByEmail returns null on 404", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return "tok";
      throw new Error("unexpected");
    });
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not_found" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await lookupUserByEmail("ghost@example.com");
      expect(r).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lookupUserByEmail throws on other non-OK statuses", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return "tok";
      throw new Error("unexpected");
    });
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "server_error" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(lookupUserByEmail("any@example.com")).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("listSandboxes returns empty remote when sandbox_list rejects", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      if (cmd === "sandbox_list_cached") {
        return {
          sandboxes: [
            {
              sandbox_id: "a",
              name: "a",
              owner_user_id: "o",
              blob_size_bytes: 1,
              pulled_at: "now",
              expires_at: "soon",
            },
          ],
        };
      }
      if (cmd === "sandbox_list") {
        throw new Error("network down");
      }
      throw new Error("unexpected");
    });
    const { cached, remote } = await listSandboxes();
    expect(cached).toHaveLength(1);
    expect(remote).toEqual([]);
  });

  it("publishSandbox forwards all args to sandbox_publish RPC", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "auth_token_get") return null;
      return { sandbox_id: "sb-1" };
    });
    const result = await publishSandbox({
      outPath: "C:\\path\\to\\sandbox.vsk",
      sandboxName: "test",
      ttlDays: 7,
      memberUserIds: ["u-1"],
      specJson: { source: { schemaName: "TEST" } },
    });
    expect(invoke).toHaveBeenCalledWith(
      "sandbox_publish",
      expect.objectContaining({
        payload: expect.objectContaining({
          outPath: "C:\\path\\to\\sandbox.vsk",
          sandboxName: "test",
          ttlDays: 7,
          memberUserIds: ["u-1"],
          specJson: { source: { schemaName: "TEST" } },
        }),
      }),
    );
    expect(result).toEqual({ sandbox_id: "sb-1" });
  });
});
