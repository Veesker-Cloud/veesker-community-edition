import { describe, it, expect } from "bun:test";
import { listSchemaTables, buildListSchemaTablesSql } from "./list-schema-tables";

describe("buildListSchemaTablesSql", () => {
  it("returns owner-bound query against ALL_TABLES + USER_SEGMENTS", () => {
    const sql = buildListSchemaTablesSql();
    expect(sql).toContain("FROM ALL_TABLES");
    expect(sql).toContain(":owner");
    expect(sql).toContain("ORDER BY table_name");
  });
});

describe("listSchemaTables", () => {
  it("returns rows mapped to SchemaTableInfo shape", async () => {
    const fakeConn = {
      execute: async () => ({
        rows: [
          { TABLE_NAME: "ORDERS", NUM_ROWS: 42310, SIZE_BYTES: 8_200_000 },
          { TABLE_NAME: "CUSTOMERS", NUM_ROWS: null, SIZE_BYTES: null },
        ],
      }),
    } as never;
    const out = await listSchemaTables(fakeConn, "HR_DEV");
    expect(out).toEqual([
      { name: "ORDERS", rowCount: 42310, sizeBytesEst: 8_200_000 },
      { name: "CUSTOMERS", rowCount: null, sizeBytesEst: null },
    ]);
  });

  it("returns empty array when Oracle returns no rows", async () => {
    const fakeConn = { execute: async () => ({ rows: [] }) } as never;
    expect(await listSchemaTables(fakeConn, "EMPTY_SCHEMA")).toEqual([]);
  });
});
