import { describe, expect, it } from "bun:test";
import { buildSandbox, sqlLiteral, type BuildEnv } from "./build";
import type {
  SandboxBuildSpec,
  BuildProgressEvent,
  SandboxBuildResult,
} from "./types";

describe("sandbox build orchestrator (mock env)", () => {
  function mockSpec(overrides: Partial<SandboxBuildSpec> = {}): SandboxBuildSpec {
    return {
      connectionId: "test-conn",
      schemaName: "OWN",
      sandboxName: "test",
      ttlDays: 7,
      piiLevel: 2,
      ownerAccount: "owner@test",
      primaryTables: [{ name: "ORDERS" }],
      outPath: "/tmp/test.vsk",
      ...overrides,
    };
  }

  function mockEnv(): BuildEnv {
    return {
      openConnection: async () => ({ close: async () => {} } as { close: () => Promise<void> }),
      introspect: async () => [
        { name: "ID", dataType: "NUMBER", dataLength: 22, dataPrecision: 10, dataScale: 0, nullable: false, columnId: 1 },
        { name: "TOTAL", dataType: "NUMBER", dataLength: 22, dataPrecision: 18, dataScale: 2, nullable: true, columnId: 2 },
      ],
      fkSingleHop: async () => [],
      extractRows: async () => [],
      writeEncryptedVskAt: async () => {},
      sealEnvelopeForOwner: async () => ({
        contentKey: new Uint8Array(32),
        envelope: { ciphertext: new Uint8Array(48), nonce: new Uint8Array(12) },
      }),
      pii: {
        sampleColumn: async () => [],
        detect: () => null,
      },
      discoverDependencies: async () => [],
      extractDdl: async (_conn, _i) => ({ ddl: "" }),
    };
  }

  it("emits a starting + done event for a minimal spec", async () => {
    const events: BuildProgressEvent[] = [];
    const result: SandboxBuildResult = await buildSandbox(
      mockSpec(),
      mockEnv(),
      (e) => events.push(e),
    );
    expect(events[0]?.phase).toBe("starting");
    expect(events[events.length - 1]?.phase).toBe("done");
    expect(result.tableCount).toBeGreaterThanOrEqual(1);
    expect(result.outPath).toBe("/tmp/test.vsk");
    expect(result.ttlExpiresAt).toMatch(/T.*Z/);
  });

  it("rejects an empty primaryTables list", async () => {
    await expect(
      buildSandbox(
        mockSpec({ primaryTables: [] }),
        mockEnv(),
        () => {},
      ),
    ).rejects.toThrow(/primary tables/i);
  });

  it("rejects an out-of-range piiLevel", async () => {
    await expect(
      buildSandbox(
        mockSpec({ piiLevel: 99 as 0 | 1 | 2 }),
        mockEnv(),
        () => {},
      ),
    ).rejects.toThrow(/piiLevel/i);
  });

  it("rejects a ttlDays out of bounds", async () => {
    await expect(
      buildSandbox(mockSpec({ ttlDays: 0 }), mockEnv(), () => {}),
    ).rejects.toThrow(/ttlDays/i);
    await expect(
      buildSandbox(mockSpec({ ttlDays: 100 }), mockEnv(), () => {}),
    ).rejects.toThrow(/ttlDays/i);
  });

  it("emits introspecting-schema and packing-vsk + done in order", async () => {
    const events: BuildProgressEvent[] = [];
    await buildSandbox(mockSpec(), mockEnv(), (e) => events.push(e));
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("introspecting-schema");
    expect(phases).toContain("packing-vsk");
    expect(phases.indexOf("done")).toBe(phases.length - 1);
  });

  it("rejects empty outPath", async () => {
    await expect(
      buildSandbox(mockSpec({ outPath: "" }), mockEnv(), () => {}),
    ).rejects.toThrow(/outPath/i);
  });

  it("rejects empty connectionId", async () => {
    await expect(
      buildSandbox(mockSpec({ connectionId: "  " }), mockEnv(), () => {}),
    ).rejects.toThrow(/connectionId/i);
  });

  it("rejects empty ownerAccount", async () => {
    await expect(
      buildSandbox(mockSpec({ ownerAccount: "" }), mockEnv(), () => {}),
    ).rejects.toThrow(/ownerAccount/i);
  });

  it("rejects malformed schemaName", async () => {
    await expect(
      buildSandbox(mockSpec({ schemaName: "OW;DROP" }), mockEnv(), () => {}),
    ).rejects.toThrow(/invalid identifier/i);
  });

  it("rejects malformed primary table name", async () => {
    await expect(
      buildSandbox(
        mockSpec({ primaryTables: [{ name: "OK" }, { name: "BAD;DROP" }] }),
        mockEnv(),
        () => {},
      ),
    ).rejects.toThrow(/invalid identifier/i);
  });

  it("rejects fkWalkDepth out of bounds", async () => {
    await expect(
      buildSandbox(mockSpec({ fkWalkDepth: 0 }), mockEnv(), () => {}),
    ).rejects.toThrow(/fkWalkDepth/i);
    await expect(
      buildSandbox(mockSpec({ fkWalkDepth: 99 }), mockEnv(), () => {}),
    ).rejects.toThrow(/fkWalkDepth/i);
  });

  it("zeroes contentKey after writeEncryptedVskAt (SDR-S-004)", async () => {
    let observedKey: Uint8Array | null = null;
    const env: BuildEnv = {
      ...mockEnv(),
      sealEnvelopeForOwner: async () => {
        const contentKey = new Uint8Array(32);
        crypto.getRandomValues(contentKey);
        observedKey = contentKey;
        return {
          contentKey,
          envelope: { ciphertext: new Uint8Array(48), nonce: new Uint8Array(12) },
        };
      },
    };
    await buildSandbox(mockSpec(), env, () => {});
    expect(observedKey).not.toBeNull();
    expect(observedKey!.length).toBe(32);
    expect(Array.from(observedKey!).every((b) => b === 0)).toBe(true);
  });

  it("zeroes contentKey even when writeEncryptedVskAt throws (SDR-S-004)", async () => {
    let observedKey: Uint8Array | null = null;
    const env: BuildEnv = {
      ...mockEnv(),
      sealEnvelopeForOwner: async () => {
        const contentKey = new Uint8Array(32);
        crypto.getRandomValues(contentKey);
        observedKey = contentKey;
        return {
          contentKey,
          envelope: { ciphertext: new Uint8Array(48), nonce: new Uint8Array(12) },
        };
      },
      writeEncryptedVskAt: async () => {
        throw new Error("simulated disk failure");
      },
    };
    await expect(buildSandbox(mockSpec(), env, () => {})).rejects.toThrow(
      /simulated disk failure/,
    );
    expect(observedKey).not.toBeNull();
    expect(Array.from(observedKey!).every((b) => b === 0)).toBe(true);
  });
});

describe("buildSandbox dryRun", () => {
  function dryRunSpec(overrides: Partial<SandboxBuildSpec> = {}): SandboxBuildSpec {
    return {
      connectionId: "test-conn",
      schemaName: "HR",
      sandboxName: "DRY_TEST",
      ttlDays: 7,
      piiLevel: 2,
      ownerAccount: "owner@test",
      primaryTables: [{ name: "EMPLOYEES" }, { name: "DEPARTMENTS" }],
      dryRun: true,
      outPath: "/tmp/should-never-be-written.vsk",
      ...overrides,
    };
  }

  function dryRunEnv(): BuildEnv {
    return {
      openConnection: async () =>
        ({ close: async () => {} } as { close: () => Promise<void> }),
      introspect: async () => [
        { name: "ID", dataType: "NUMBER", dataLength: 22, dataPrecision: 10, dataScale: 0, nullable: false, columnId: 1 },
      ],
      fkSingleHop: async () => [],
      extractRows: async () => {
        throw new Error("extractRows must not be called in dryRun mode");
      },
      writeEncryptedVskAt: async () => {
        throw new Error("writeEncryptedVskAt must not be called in dryRun mode");
      },
      sealEnvelopeForOwner: async () => {
        throw new Error("sealEnvelopeForOwner must not be called in dryRun mode");
      },
      pii: {
        sampleColumn: async () => [],
        detect: () => null,
      },
      discoverDependencies: async () => {
        throw new Error("discoverDependencies must not be called in dryRun mode");
      },
      extractDdl: async (_conn, _i) => {
        throw new Error("extractDdl must not be called in dryRun mode");
      },
    };
  }

  it("emits 'dry-run-done' after pii-scanning when dryRun=true and skips extraction", async () => {
    const events: BuildProgressEvent[] = [];
    await buildSandbox(dryRunSpec(), dryRunEnv(), (e) => events.push(e));
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("pii-scanning");
    expect(phases).toContain("dry-run-done");
    expect(phases).not.toContain("extracting");
    expect(phases).not.toContain("packing-vsk");
    expect(phases).not.toContain("encrypting");
    expect(phases).not.toContain("done");
  });

  it("the dry-run-done event carries the FK closure and pii suggestions", async () => {
    const events: BuildProgressEvent[] = [];
    await buildSandbox(dryRunSpec(), dryRunEnv(), (e) => events.push(e));
    const dryDone = events.find((e) => e.phase === "dry-run-done");
    expect(dryDone).toBeDefined();
    if (dryDone && dryDone.phase === "dry-run-done") {
      expect(dryDone.fkClosureTables).toContain("EMPLOYEES");
      expect(dryDone.fkClosureTables).toContain("DEPARTMENTS");
      expect(Array.isArray(dryDone.piiSuggestions)).toBe(true);
      expect(typeof dryDone.estimatedSizeBytes).toBe("number");
      expect(typeof dryDone.estimatedTotalRows).toBe("number");
    }
  });

  it("returns a stub SandboxBuildResult with empty outPath", async () => {
    const result = await buildSandbox(dryRunSpec(), dryRunEnv(), () => {});
    expect(result.outPath).toBe("");
    expect(result.tableCount).toBeGreaterThanOrEqual(2);
    expect(result.piiSuggestionsApplied).toBe(0);
    expect(result.ttlExpiresAt).toMatch(/T.*Z/);
  });

  it("accepts a dryRun spec with no outPath and no ownerAccount (Plan 5b wizard path)", async () => {
    const spec = dryRunSpec();
    delete (spec as Partial<SandboxBuildSpec>).outPath;
    delete (spec as Partial<SandboxBuildSpec>).ownerAccount;
    const events: BuildProgressEvent[] = [];
    await buildSandbox(spec, dryRunEnv(), (e) => events.push(e));
    expect(events.map((e) => e.phase)).toContain("dry-run-done");
  });

  it("a non-dryRun build still rejects missing outPath and ownerAccount", async () => {
    const noOutPath = dryRunSpec({ dryRun: false });
    delete (noOutPath as Partial<SandboxBuildSpec>).outPath;
    await expect(buildSandbox(noOutPath, dryRunEnv(), () => {})).rejects.toThrow(/outPath/);

    const noOwner = dryRunSpec({ dryRun: false, outPath: "/tmp/x.vsk" });
    delete (noOwner as Partial<SandboxBuildSpec>).ownerAccount;
    await expect(buildSandbox(noOwner, dryRunEnv(), () => {})).rejects.toThrow(/ownerAccount/);
  });
});

describe("buildSandbox PL/SQL integration", () => {
  function makeEnv(overrides: Partial<BuildEnv> = {}): BuildEnv {
    return {
      openConnection: async () => ({ close: async () => {} }),
      introspect: async () => [{ name: "ID", dataType: "NUMBER", nullable: false }],
      fkSingleHop: async () => [],
      extractRows: async () => [],
      writeEncryptedVskAt: async () => {},
      sealEnvelopeForOwner: async () => ({ contentKey: new Uint8Array(32), envelope: { ciphertext: new Uint8Array(0), nonce: new Uint8Array(0) } }),
      pii: { sampleColumn: async () => [], detect: () => null },
      discoverDependencies: async () => [],
      extractDdl: async (_conn, _i) => ({ ddl: "x" }),
      ...overrides,
    };
  }

  it("emits plsql-discovering and plsql-extracting events in order", async () => {
    const events: any[] = [];
    const env = makeEnv({
      discoverDependencies: async (_conn, _owner, names) => {
        if (names.includes("EMP")) {
          return [{ name: "GET_EMP", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" }];
        }
        return [];
      },
      extractDdl: async (_conn, { name }) => ({ ddl: `CREATE PROCEDURE ${name.toLowerCase()} AS BEGIN NULL; END;` }),
    });
    await buildSandbox(
      {
        connectionId: "c1",
        schemaName: "HR",
        sandboxName: "test",
        primaryTables: [{ name: "EMP" }],
        ttlDays: 1,
        piiLevel: 0,
        outPath: "/tmp/x.vsk",
        ownerAccount: "geefa",
      } as any,
      env,
      (e) => events.push(e),
    );
    const discIdx = events.findIndex((e) => e.phase === "plsql-discovering");
    const extrIdx = events.findIndex((e) => e.phase === "plsql-extracting");
    const packIdx = events.findIndex((e) => e.phase === "packing-vsk");
    expect(discIdx).toBeGreaterThanOrEqual(0);
    expect(extrIdx).toBeGreaterThan(discIdx);
    expect(packIdx).toBeGreaterThan(extrIdx);
    expect(events[extrIdx]).toMatchObject({ phase: "plsql-extracting", objectsTotal: 1, objectsDone: 1 });
  });

  it("manifest engineVersion is 0.2.0 with plsqlObjectCount", async () => {
    let captured: any = null;
    const env = makeEnv({
      writeEncryptedVskAt: async (_o, manifest) => { captured = manifest; },
      discoverDependencies: async () => [
        { name: "GET_EMP", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
      ],
      extractDdl: async (_conn, _i) => ({ ddl: "..." }),
    });
    await buildSandbox(
      {
        connectionId: "c1",
        schemaName: "HR",
        sandboxName: "t",
        primaryTables: [{ name: "EMP" }],
        ttlDays: 1,
        piiLevel: 0,
        outPath: "/tmp/x.vsk",
        ownerAccount: "g",
      } as any,
      env,
      () => {},
    );
    expect(captured.engineVersion).toBe("0.2.0");
    expect(captured.plsqlObjectCount).toBe(1);
  });

  it("respects spec.excludedPlsql — excluded objects do NOT appear in manifest count", async () => {
    let captured: any = null;
    const env = makeEnv({
      writeEncryptedVskAt: async (_o, manifest) => { captured = manifest; },
      discoverDependencies: async () => [
        { name: "GET_EMP",  type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
        { name: "DROP_EMP", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
      ],
      extractDdl: async (_conn, _i) => ({ ddl: "..." }),
    });
    await buildSandbox(
      {
        connectionId: "c1",
        schemaName: "HR",
        sandboxName: "t",
        primaryTables: [{ name: "EMP" }],
        ttlDays: 1,
        piiLevel: 0,
        outPath: "/tmp/x.vsk",
        ownerAccount: "g",
        excludedPlsql: [{ kind: "PROCEDURE", owner: "HR", name: "DROP_EMP" }],
      } as any,
      env,
      () => {},
    );
    expect(captured.plsqlObjectCount).toBe(1);
  });

  it("DDL extraction failures land in skippedObjects", async () => {
    let captured: any = null;
    const env = makeEnv({
      writeEncryptedVskAt: async (_o, manifest) => { captured = manifest; },
      discoverDependencies: async () => [
        { name: "BAD_PROC", type: "PROCEDURE", referencedName: "EMP", referencedOwner: "HR", referencedType: "TABLE" },
      ],
      extractDdl: async (_conn, _i) => { throw new Error("ORA-31603 something"); },
    });
    await buildSandbox(
      {
        connectionId: "c1",
        schemaName: "HR",
        sandboxName: "t",
        primaryTables: [{ name: "EMP" }],
        ttlDays: 1,
        piiLevel: 0,
        outPath: "/tmp/x.vsk",
        ownerAccount: "g",
      } as any,
      env,
      () => {},
    );
    expect(captured.skippedObjects).toHaveLength(1);
    expect(captured.skippedObjects[0].reason).toBe("EXTRACTION_ERROR");
    expect(captured.plsqlObjectCount).toBe(0);
  });
});

describe("makeProductionBuildEnv (compile-time only)", () => {
  it("can be imported without error", async () => {
    const { makeProductionBuildEnv } = await import("./build");
    expect(typeof makeProductionBuildEnv).toBe("function");
  });
});

describe("sqlLiteral", () => {
  it("null returns NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
  });
  it("undefined returns NULL", () => {
    expect(sqlLiteral(undefined)).toBe("NULL");
  });
  it("number returns unquoted", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(-3.14)).toBe("-3.14");
  });
  it("bigint returns unquoted", () => {
    expect(sqlLiteral(123n)).toBe("123");
  });
  it("boolean returns TRUE or FALSE", () => {
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(false)).toBe("FALSE");
  });
  it("Date returns TIMESTAMP literal", () => {
    const d = new Date("2026-04-30T12:00:00.000Z");
    expect(sqlLiteral(d)).toBe("TIMESTAMP '2026-04-30 12:00:00'");
  });
  it("string with embedded single quotes is escaped via doubling", () => {
    expect(sqlLiteral("O'Reilly")).toBe("'O''Reilly'");
  });
  it("string with embedded null byte strips the null byte", () => {
    expect(sqlLiteral("foo\x00bar")).toBe("'foobar'");
  });
  it("Uint8Array returns hex literal", () => {
    expect(sqlLiteral(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("X'deadbeef'");
  });
  it("Buffer (Uint8Array subclass) returns hex literal", () => {
    expect(sqlLiteral(Buffer.from([0x00, 0x01, 0xff]))).toBe("X'0001ff'");
  });
  it("empty string returns empty quoted literal", () => {
    expect(sqlLiteral("")).toBe("''");
  });
  it("empty Uint8Array returns empty hex literal", () => {
    expect(sqlLiteral(new Uint8Array(0))).toBe("X''");
  });
  it("NaN returns 'NaN'::DOUBLE", () => {
    expect(sqlLiteral(Number.NaN)).toBe("'NaN'::DOUBLE");
  });
  it("Infinity returns 'inf'::DOUBLE", () => {
    expect(sqlLiteral(Infinity)).toBe("'inf'::DOUBLE");
  });
  it("-Infinity returns '-inf'::DOUBLE", () => {
    expect(sqlLiteral(-Infinity)).toBe("'-inf'::DOUBLE");
  });
  it("Invalid Date returns NULL (with stderr warning)", () => {
    expect(sqlLiteral(new Date("invalid"))).toBe("NULL");
  });
});
