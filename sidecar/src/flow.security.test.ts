// Regression test for the PL/SQL identifier-injection defense in
// flow.traceProc (F-F-001 from the 2026-05-14 security audit).
//
// Before the fix, traceProc spliced p.owner and p.name into a BEGIN/END
// anonymous block without validation, bypassing enforceSafetyForStatement
// because the block ran through DBMS_DEBUG and not the normal query path.
// After the fix, validateOracleIdentifier is invoked at the top of
// traceProc on the uppercased owner + name and rejects malicious input
// BEFORE any debug session is created.

import { describe, it, expect } from "bun:test";
import { traceProc } from "./flow";
import { RpcCodedError, INVALID_IDENTIFIER } from "./errors";

describe("flow.traceProc — identifier injection defense (F-F-001)", () => {
  it("rejects malicious owner with INVALID_IDENTIFIER before opening a debug session", async () => {
    let caught: unknown = null;
    try {
      await traceProc({
        owner: "HR; DROP TABLE EMPLOYEES--",
        name: "GATHER_STATS",
        params: [],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RpcCodedError);
    expect((caught as RpcCodedError).code).toBe(INVALID_IDENTIFIER);
    expect((caught as RpcCodedError).message).toMatch(/Invalid owner/);
  });

  it("rejects malicious name with INVALID_IDENTIFIER", async () => {
    let caught: unknown = null;
    try {
      await traceProc({
        owner: "HR",
        name: "X(); EXECUTE IMMEDIATE 'DROP TABLE EMPLOYEES'--",
        params: [],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RpcCodedError);
    expect((caught as RpcCodedError).code).toBe(INVALID_IDENTIFIER);
    expect((caught as RpcCodedError).message).toMatch(/Invalid procedure name/);
  });

  it("rejects owner starting with a digit (Oracle identifier rule)", async () => {
    let caught: unknown = null;
    try {
      await traceProc({ owner: "1HR", name: "GATHER_STATS", params: [] });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RpcCodedError);
    expect((caught as RpcCodedError).code).toBe(INVALID_IDENTIFIER);
  });

  it("rejects identifier exceeding 128 characters", async () => {
    const tooLong = "A".repeat(129);
    let caught: unknown = null;
    try {
      await traceProc({ owner: tooLong, name: "GATHER_STATS", params: [] });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RpcCodedError);
    expect((caught as RpcCodedError).code).toBe(INVALID_IDENTIFIER);
  });

  it("rejects owner containing a quote character", async () => {
    let caught: unknown = null;
    try {
      await traceProc({ owner: "H'R", name: "GATHER_STATS", params: [] });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RpcCodedError);
    expect((caught as RpcCodedError).code).toBe(INVALID_IDENTIFIER);
  });
});
