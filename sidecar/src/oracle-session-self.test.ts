import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  SESSION_SELF_PRIV_MISSING,
  SESSION_SELF_TRANSIENT,
  SESSION_SELF_NOT_FOUND,
} from "./errors";
import { extractServiceName } from "./oracle";

const mockExecute = mock(() => Promise.resolve({ rows: [] }));
const mockConn = { execute: mockExecute } as any;

mock.module("./state", () => ({
  getActiveSession: () => mockConn,
}));

import { querySessionSelf } from "./oracle";

beforeEach(() => {
  mockExecute.mockReset();
});

describe("querySessionSelf", () => {
  it("returns full row when V$SESSION query succeeds", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        SID: 142,
        SERIAL_NUM: 39481,
        USERNAME: "GIMBIAS",
        OSUSER: "geefa",
        MACHINE: "WORKSTATION",
        PROGRAM: "Veesker IDE",
        LOGON_TIME: "2026-05-06T14:32:11",
        MODULE: "Veesker IDE",
        ACTION: "SQL Editor",
        CLIENT_INFO: null,
        CLIENT_IDENTIFIER: "vsk-abc-123",
        STATUS: "ACTIVE",
        STATE: "WAITING",
        EVENT: "SQL*Net message from client",
        SQL_ID: "9d3xy4hbz0p2k",
        BLOCKING_SESSION: null,
        BLOCKING_SESSION_STATUS: null,
      }],
    });

    const result = await querySessionSelf();

    expect(result.sid).toBe(142);
    expect(result.serial).toBe(39481);
    expect(result.username).toBe("GIMBIAS");
    expect(result.module).toBe("Veesker IDE");
    expect(result.event).toBe("SQL*Net message from client");
    expect(result.sqlId).toBe("9d3xy4hbz0p2k");
    expect(result.blockingSession).toBeUndefined();
  });

  it("includes blockingSession only when not NULL", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        SID: 142, SERIAL_NUM: 1, USERNAME: "X", OSUSER: null, MACHINE: null,
        PROGRAM: null, LOGON_TIME: "2026-05-06T00:00:00",
        MODULE: null, ACTION: null, CLIENT_INFO: null, CLIENT_IDENTIFIER: null,
        STATUS: "ACTIVE", STATE: "WAITING", EVENT: null, SQL_ID: null,
        BLOCKING_SESSION: 99, BLOCKING_SESSION_STATUS: "VALID",
      }],
    });

    const result = await querySessionSelf();
    expect(result.blockingSession).toBe(99);
    expect(result.blockingSessionStatus).toBe("VALID");
  });

  it("throws SESSION_SELF_PRIV_MISSING when ORA-00942", async () => {
    const oraErr: any = new Error("ORA-00942: table or view does not exist");
    oraErr.errorNum = 942;
    mockExecute.mockRejectedValueOnce(oraErr);

    let caught: any;
    await querySessionSelf().catch((e) => { caught = e; });

    expect(caught).toBeDefined();
    expect(caught.code).toBe(SESSION_SELF_PRIV_MISSING);
    expect(caught.data?.kind).toBe("missing_privilege");
    expect(caught.data?.grant).toContain("GRANT SELECT ON V_$SESSION");
  });

  it("throws SESSION_SELF_NOT_FOUND when query returns empty", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    let caught: any;
    await querySessionSelf().catch((e) => { caught = e; });

    expect(caught.code).toBe(SESSION_SELF_NOT_FOUND);
    expect(caught.data?.kind).toBe("session_self_not_found");
  });

  it("throws SESSION_SELF_TRANSIENT for other Oracle errors", async () => {
    const oraErr: any = new Error("ORA-03114: not connected to ORACLE");
    oraErr.errorNum = 3114;
    mockExecute.mockRejectedValueOnce(oraErr);

    let caught: any;
    await querySessionSelf().catch((e) => { caught = e; });

    expect(caught.code).toBe(SESSION_SELF_TRANSIENT);
    expect(caught.data?.kind).toBe("transient");
    expect(caught.data?.oracleCode).toBe(3114);
  });

  it("omits oracleCode from transient data when not an Oracle error", async () => {
    const genericErr = new Error("network blip");
    mockExecute.mockRejectedValueOnce(genericErr);

    let caught: any;
    await querySessionSelf().catch((e) => { caught = e; });

    expect(caught.code).toBe(SESSION_SELF_TRANSIENT);
    expect(caught.data?.kind).toBe("transient");
    expect(caught.data?.oracleCode).toBeUndefined();
  });
});

describe("extractServiceName", () => {
  it("parses easy connect string host:port/service", () => {
    expect(extractServiceName("dbhost:1521/PROD")).toBe("PROD");
  });

  it("parses easy connect with double slash //host:port/service", () => {
    expect(extractServiceName("//dbhost:1521/PROD_EBS")).toBe("PROD_EBS");
  });

  it("parses TNS descriptor with SERVICE_NAME", () => {
    const tns = "(DESCRIPTION=(ADDRESS=(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))";
    expect(extractServiceName(tns)).toBe("ORCL");
  });

  it("returns empty string for empty input", () => {
    expect(extractServiceName("")).toBe("");
  });

  it("returns trimmed input verbatim when no pattern matches (fallback)", () => {
    expect(extractServiceName("unknown-alias-no-slashes")).toBe("unknown-alias-no-slashes");
    expect(extractServiceName("  PROD_EBS  ")).toBe("PROD_EBS");
  });
});
