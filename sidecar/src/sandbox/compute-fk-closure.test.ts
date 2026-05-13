// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect } from "bun:test";
import { computeFkClosure } from "./compute-fk-closure";

describe("computeFkClosure", () => {
  it("returns explicit-only entries when there are no FK edges", async () => {
    const noEdges = async () => [];
    const out = await computeFkClosure({
      owner: "HR",
      primaryTables: ["ORDERS"],
      maxDepth: 2,
      singleHop: noEdges,
    });
    expect(out.entries).toEqual([
      { name: "ORDERS", depth: 0 },
    ]);
    expect(out.edges).toEqual([]);
  });

  it("expands FK edges by depth and tags entries with viaFk", async () => {
    const fakeSingleHop = async (_owner: string, frontier: string[]) => {
      if (frontier.includes("ORDERS")) {
        return [{
          fromTable: "ORDERS",
          fromColumns: ["CUSTOMER_ID"],
          toTable: "CUSTOMERS",
          toColumns: ["ID"],
        }];
      }
      if (frontier.includes("CUSTOMERS")) {
        return [{
          fromTable: "CUSTOMERS",
          fromColumns: ["COUNTRY_ID"],
          toTable: "COUNTRIES",
          toColumns: ["ID"],
        }];
      }
      return [];
    };
    const out = await computeFkClosure({
      owner: "HR",
      primaryTables: ["ORDERS"],
      maxDepth: 2,
      singleHop: fakeSingleHop,
    });
    expect(out.entries.map((e) => ({ name: e.name, depth: e.depth }))).toEqual([
      { name: "ORDERS", depth: 0 },
      { name: "CUSTOMERS", depth: 1 },
      { name: "COUNTRIES", depth: 2 },
    ]);
    const customers = out.entries.find((e) => e.name === "CUSTOMERS");
    expect(customers?.viaFk?.fromTable).toBe("ORDERS");
    expect(customers?.viaFk?.fromColumns).toEqual(["CUSTOMER_ID"]);
  });

  it("respects maxDepth boundary (depth-2 tables not pulled when maxDepth=1)", async () => {
    const fakeSingleHop = async (_owner: string, frontier: string[]) => {
      if (frontier.includes("ORDERS")) {
        return [{ fromTable: "ORDERS", fromColumns: ["CUSTOMER_ID"], toTable: "CUSTOMERS", toColumns: ["ID"] }];
      }
      if (frontier.includes("CUSTOMERS")) {
        return [{ fromTable: "CUSTOMERS", fromColumns: ["COUNTRY_ID"], toTable: "COUNTRIES", toColumns: ["ID"] }];
      }
      return [];
    };
    const out = await computeFkClosure({
      owner: "HR",
      primaryTables: ["ORDERS"],
      maxDepth: 1,
      singleHop: fakeSingleHop,
    });
    expect(out.entries.map((e) => e.name)).toEqual(["ORDERS", "CUSTOMERS"]);
    expect(out.entries.find((e) => e.name === "COUNTRIES")).toBeUndefined();
  });

  it("survives FK cycles without infinite loop or duplicate entries", async () => {
    const fakeSingleHop = async (_owner: string, frontier: string[]) => {
      if (frontier.includes("A")) {
        return [{ fromTable: "A", fromColumns: ["B_ID"], toTable: "B", toColumns: ["ID"] }];
      }
      if (frontier.includes("B")) {
        return [{ fromTable: "B", fromColumns: ["A_ID"], toTable: "A", toColumns: ["ID"] }];
      }
      return [];
    };
    const out = await computeFkClosure({
      owner: "HR",
      primaryTables: ["A"],
      maxDepth: 5,
      singleHop: fakeSingleHop,
    });
    expect(out.entries.map((e) => ({ name: e.name, depth: e.depth }))).toEqual([
      { name: "A", depth: 0 },
      { name: "B", depth: 1 },
    ]);
  });

  it("picks lexicographically-smallest fromTable when multiple FKs reach the same table", async () => {
    const fakeSingleHop = async (_owner: string, frontier: string[]) => {
      if (frontier.includes("ORDER_ITEMS") || frontier.includes("RETURNS")) {
        return [
          { fromTable: "RETURNS", fromColumns: ["PRODUCT_ID"], toTable: "PRODUCTS", toColumns: ["ID"] },
          { fromTable: "ORDER_ITEMS", fromColumns: ["PRODUCT_ID"], toTable: "PRODUCTS", toColumns: ["ID"] },
        ];
      }
      return [];
    };
    const out = await computeFkClosure({
      owner: "HR",
      primaryTables: ["ORDER_ITEMS", "RETURNS"],
      maxDepth: 2,
      singleHop: fakeSingleHop,
    });
    const products = out.entries.find((e) => e.name === "PRODUCTS");
    expect(products?.viaFk?.fromTable).toBe("ORDER_ITEMS");
  });
});
