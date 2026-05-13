import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import oracledb from "oracledb";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

import {
  DuckDBHost,
  readEncryptedVsk,
  sodiumReady,
  publicKeyFromPrivate,
  OsKeyringStore,
} from "@veesker/engine";
import { handleSandboxBuild } from "../src/sandbox.handler";

const ORACLE_USER = process.env.VSK_TEST_ORACLE_USER ?? "system";
const ORACLE_PASSWORD = process.env.VSK_TEST_ORACLE_PASSWORD ?? "Veesker123";
const ORACLE_CONNECT_STRING = process.env.VSK_TEST_ORACLE_CONNECTION ?? "localhost:1521/FREEPDB1";

let oracleAvailable = false;

beforeAll(async () => {
  try {
    const conn = await oracledb.getConnection({
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
      connectString: ORACLE_CONNECT_STRING,
    });
    await conn.close();
    oracleAvailable = true;
  } catch {
    oracleAvailable = false;
    console.log("[sandbox.integration] Oracle not reachable — tests will be skipped");
  }
});

describe("sandbox build — integration against Oracle 23ai Free", () => {
  const SCHEMA = "VSK_SANDBOX_TEST";
  const ACCOUNT = `vsk-build-test-${process.pid}-${Date.now()}`;
  const TMP_VSK = join(tmpdir(), `vsk-build-${process.pid}-${Date.now()}.vsk`);

  beforeAll(async () => {
    if (!oracleAvailable) return;

    const conn = await oracledb.getConnection({
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
      connectString: ORACLE_CONNECT_STRING,
    });
    try {
      try {
        await conn.execute(`DROP USER ${SCHEMA} CASCADE`);
      } catch {/* may not exist */}
      await conn.execute(`CREATE USER ${SCHEMA} IDENTIFIED BY Veesker123`);
      await conn.execute(`GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO ${SCHEMA}`);

      await conn.close();
      const userConn = await oracledb.getConnection({
        user: SCHEMA,
        password: "Veesker123",
        connectString: ORACLE_CONNECT_STRING,
      });
      try {
        await userConn.execute(`
          CREATE TABLE customers (
            id NUMBER(10) PRIMARY KEY,
            email VARCHAR2(100),
            full_name VARCHAR2(200),
            cpf VARCHAR2(14)
          )
        `);
        await userConn.execute(`
          CREATE TABLE orders (
            id NUMBER(10) PRIMARY KEY,
            customer_id NUMBER(10) NOT NULL,
            total NUMBER(18,2),
            placed_at TIMESTAMP,
            CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES customers (id)
          )
        `);
        await userConn.execute(`INSERT INTO customers VALUES (1, 'alice@example.com', 'Alice Silva', '123.456.789-09')`);
        await userConn.execute(`INSERT INTO customers VALUES (2, 'bob@example.com', 'Bob Souza', '234.567.890-12')`);
        await userConn.execute(`INSERT INTO orders VALUES (1, 1, 49.90, CURRENT_TIMESTAMP)`);
        await userConn.execute(`INSERT INTO orders VALUES (2, 1, 120.50, CURRENT_TIMESTAMP)`);
        await userConn.execute(`INSERT INTO orders VALUES (3, 2, 9.99, CURRENT_TIMESTAMP)`);
        await userConn.commit();
      } finally {
        await userConn.close();
      }
    } catch (err) {
      console.error("[sandbox.integration] setup failed:", err);
      throw err;
    }
  });

  afterAll(async () => {
    if (!oracleAvailable) return;
    try {
      const conn = await oracledb.getConnection({
        user: ORACLE_USER,
        password: ORACLE_PASSWORD,
        connectString: ORACLE_CONNECT_STRING,
      });
      try {
        await conn.execute(`DROP USER ${SCHEMA} CASCADE`);
      } catch {/* best effort */}
      await conn.close();
    } catch {/* best effort */}
    try { unlinkSync(TMP_VSK); } catch {/* best effort */}
    try {
      const store = new OsKeyringStore("veesker-cl", ACCOUNT);
      await store.deletePrivateKey();
    } catch {/* best effort */}
  });

  it("builds a sandbox from ORDERS (FK-walks to CUSTOMERS) with PII detection", async () => {
    if (!oracleAvailable) return;

    const response = await handleSandboxBuild({
      spec: {
        connectionId: "test-direct",
        schemaName: SCHEMA,
        sandboxName: "test-sandbox",
        ttlDays: 1,
        piiLevel: 2,
        ownerAccount: ACCOUNT,
        primaryTables: [{ name: "ORDERS" }],
        outPath: TMP_VSK,
      },
      oracleConfig: {
        user: SCHEMA,
        password: "Veesker123",
        connectString: ORACLE_CONNECT_STRING,
      },
    });

    expect(response.result.tableCount).toBeGreaterThanOrEqual(2);
    expect(response.result.totalRows).toBeGreaterThanOrEqual(5);
    expect(response.result.piiSuggestionsApplied).toBeGreaterThanOrEqual(2);

    await sodiumReady();
    const store = new OsKeyringStore("veesker-cl", ACCOUNT);
    const priv = await store.getPrivateKey();
    expect(priv).not.toBeNull();
    const pub = publicKeyFromPrivate(priv!);

    const dst = await DuckDBHost.openInMemory();
    try {
      const { manifest } = await readEncryptedVsk(
        TMP_VSK,
        dst,
        pub,
        { publicKey: pub, privateKey: priv! },
      );
      expect(manifest.tables.map((t: { name: string }) => t.name).sort()).toEqual(["CUSTOMERS", "ORDERS"]);
      const orderRows = await dst.query(`SELECT COUNT(*) AS n FROM "orders"`);
      expect(Number(orderRows[0]?.n)).toBe(3);
      const customerRows = await dst.query(`SELECT COUNT(*) AS n FROM "customers"`);
      expect(Number(customerRows[0]?.n)).toBe(2);
    } finally {
      await dst.close();
    }
  }, 60_000);
});
