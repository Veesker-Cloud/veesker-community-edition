import { describe, expect, it } from "bun:test";
import {
  buildFkSingleHopSql,
  isLookupTable,
  parseFkRows,
  walkFkBfs,
  type FkBfsResult,
  type FkEdge,
} from "./fk-walk";

describe("fk-walk SQL builder", () => {
  it("builds a parameterized single-hop SQL using ALL_CONSTRAINTS", () => {
    const sql = buildFkSingleHopSql();
    expect(sql).toContain("ALL_CONSTRAINTS");
    expect(sql).toContain(":owner");
    expect(sql.toLowerCase()).toContain("constraint_type = 'r'");
    expect(sql).toContain(":table_names");
  });
});

describe("fk-walk row parser", () => {
  it("parses introspection rows into edges", () => {
    const rows = [
      {
        FROM_TABLE: "ORDERS",
        FROM_COLUMNS: "CUSTOMER_ID",
        TO_TABLE: "CUSTOMERS",
        TO_COLUMNS: "ID",
      },
      {
        FROM_TABLE: "ORDER_ITEMS",
        FROM_COLUMNS: "ORDER_ID,LINE_NO",
        TO_TABLE: "ORDERS",
        TO_COLUMNS: "ID,LINE_NO",
      },
    ];
    const edges: FkEdge[] = parseFkRows(rows);
    expect(edges).toEqual([
      {
        fromTable: "ORDERS",
        fromColumns: ["CUSTOMER_ID"],
        toTable: "CUSTOMERS",
        toColumns: ["ID"],
      },
      {
        fromTable: "ORDER_ITEMS",
        fromColumns: ["ORDER_ID", "LINE_NO"],
        toTable: "ORDERS",
        toColumns: ["ID", "LINE_NO"],
      },
    ]);
  });

  it("handles empty rows", () => {
    expect(parseFkRows([])).toEqual([]);
  });

  it("trims column-list whitespace", () => {
    const edges = parseFkRows([
      {
        FROM_TABLE: "T",
        FROM_COLUMNS: " A , B , C ",
        TO_TABLE: "U",
        TO_COLUMNS: "X",
      },
    ]);
    expect(edges[0]?.fromColumns).toEqual(["A", "B", "C"]);
  });
});

describe("fk-walk BFS", () => {
  it("expands from primary tables outward by depth", async () => {
    const edges: FkEdge[] = [
      { fromTable: "ORDERS", fromColumns: ["CUSTOMER_ID"], toTable: "CUSTOMERS", toColumns: ["ID"] },
      { fromTable: "ORDERS", fromColumns: ["PRODUCT_ID"], toTable: "PRODUCTS", toColumns: ["ID"] },
      { fromTable: "PRODUCTS", fromColumns: ["CATEGORY_ID"], toTable: "CATEGORIES", toColumns: ["ID"] },
    ];
    const mockHop = async (_owner: string, tables: string[]) => {
      return edges.filter((e) => tables.includes(e.fromTable) || tables.includes(e.toTable));
    };

    const result = await walkFkBfs("OWN", ["ORDERS"], mockHop, 2);
    expect(result.tablesIncluded.sort()).toEqual([
      "CATEGORIES", "CUSTOMERS", "ORDERS", "PRODUCTS",
    ]);
  });

  it("stops at depth limit", async () => {
    const edges: FkEdge[] = [
      { fromTable: "A", fromColumns: ["B_ID"], toTable: "B", toColumns: ["ID"] },
      { fromTable: "B", fromColumns: ["C_ID"], toTable: "C", toColumns: ["ID"] },
      { fromTable: "C", fromColumns: ["D_ID"], toTable: "D", toColumns: ["ID"] },
    ];
    const mockHop = async (_owner: string, tables: string[]) =>
      edges.filter((e) => tables.includes(e.fromTable) || tables.includes(e.toTable));

    const r1 = await walkFkBfs("OWN", ["A"], mockHop, 1);
    expect(r1.tablesIncluded.sort()).toEqual(["A", "B"]);

    const r2 = await walkFkBfs("OWN", ["A"], mockHop, 2);
    expect(r2.tablesIncluded.sort()).toEqual(["A", "B", "C"]);
  });

  it("handles cycles without infinite loop", async () => {
    const edges: FkEdge[] = [
      { fromTable: "A", fromColumns: ["B_ID"], toTable: "B", toColumns: ["ID"] },
      { fromTable: "B", fromColumns: ["A_ID"], toTable: "A", toColumns: ["ID"] },
    ];
    const mockHop = async (_owner: string, tables: string[]) =>
      edges.filter((e) => tables.includes(e.fromTable) || tables.includes(e.toTable));

    const result = await walkFkBfs("OWN", ["A"], mockHop, 5);
    expect(result.tablesIncluded.sort()).toEqual(["A", "B"]);
  });

  it("returns each table's depth-of-discovery", async () => {
    const edges: FkEdge[] = [
      { fromTable: "X", fromColumns: ["Y_ID"], toTable: "Y", toColumns: ["ID"] },
      { fromTable: "Y", fromColumns: ["Z_ID"], toTable: "Z", toColumns: ["ID"] },
    ];
    const mockHop = async (_owner: string, tables: string[]) =>
      edges.filter((e) => tables.includes(e.fromTable) || tables.includes(e.toTable));

    const result = await walkFkBfs("OWN", ["X"], mockHop, 3);
    expect(result.tableDepths).toEqual({ X: 0, Y: 1, Z: 2 });
  });

  it("deduplicates edges discovered from both sides", async () => {
    // Edge A→B will be returned by single-hop both when A is the frontier
    // (matches fromTable) and when B is in the next frontier (matches
    // toTable). The BFS must dedup so the result has one canonical entry.
    const edges: FkEdge[] = [
      { fromTable: "A", fromColumns: ["B_ID"], toTable: "B", toColumns: ["ID"] },
    ];
    const mockHop = async (_owner: string, tables: string[]) =>
      edges.filter((e) => tables.includes(e.fromTable) || tables.includes(e.toTable));

    const result = await walkFkBfs("OWN", ["A"], mockHop, 3);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0]).toEqual({
      fromTable: "A",
      fromColumns: ["B_ID"],
      toTable: "B",
      toColumns: ["ID"],
    });
  });
});

describe("fk-walk lookup heuristic", () => {
  it("flags small tables that are FK'd-to from many places", () => {
    const stats = {
      table: "STATUS",
      rowCount: 5,
      incomingFkCount: 4,
    };
    expect(isLookupTable(stats)).toBe(true);
  });

  it("does not flag big tables", () => {
    const stats = {
      table: "ORDERS",
      rowCount: 1_000_000,
      incomingFkCount: 1,
    };
    expect(isLookupTable(stats)).toBe(false);
  });

  it("does not flag small but rarely-FK'd tables", () => {
    const stats = {
      table: "MIGRATIONS",
      rowCount: 5,
      incomingFkCount: 0,
    };
    expect(isLookupTable(stats)).toBe(false);
  });
});
