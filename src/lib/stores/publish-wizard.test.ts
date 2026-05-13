// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, it, expect } from "vitest";
import { createPublishWizard } from "./publish-wizard.svelte";

describe("publish wizard state machine", () => {
  it("starts at step 1 with empty source", () => {
    const w = createPublishWizard();
    expect(w.state.currentStep).toBe(1);
    expect(w.state.source.connectionId).toBeNull();
    expect(w.state.source.credsReady).toBe(false);
  });

  it("blocks advance from step 1 until connection AND credsReady are set", () => {
    const w = createPublishWizard();
    expect(w.canAdvance()).toBe(false);
    w.setSource("conn-1", "HR_DEV");
    expect(w.canAdvance()).toBe(false);
    w.setCredsReady(true);
    expect(w.canAdvance()).toBe(true);
    w.next();
    expect(w.state.currentStep).toBe(2);
  });

  it("blocks advance from step 2 until at least one explicit table is added", () => {
    const w = createPublishWizard();
    w.setSource("conn-1", "HR_DEV", true);
    w.next();
    expect(w.canAdvance()).toBe(false);
    w.addExplicitTable("ORDERS");
    expect(w.canAdvance()).toBe(true);
  });

  it("blocks advance from step 3 with empty sandboxName", () => {
    const w = createPublishWizard();
    w.setSource("conn-1", "HR_DEV", true);
    w.next();
    w.addExplicitTable("ORDERS");
    w.next();
    expect(w.state.currentStep).toBe(3);
    expect(w.canAdvance()).toBe(false);
    w.setSpec({ sandboxName: "ORDERS_2025", ttlDays: 7, piiLevel: 2 });
    expect(w.canAdvance()).toBe(true);
  });

  it("changing source schema clears table picks + dryRun review state", () => {
    const w = createPublishWizard();
    w.setSource("conn-1", "HR_DEV", true);
    w.addExplicitTable("EMPLOYEES");
    w.addManual("DEPARTMENTS");
    w.applyFkClosure({ entries: [{ name: "JOBS", depth: 1 }], edges: [] });
    w.setAvailableTables([{ name: "EMPLOYEES", rowCount: 100, sizeBytesEst: 1024 }]);
    w.setDryRunStatus("ok");
    // Pick a different connection (and schema)
    w.setSource("conn-2", "FIN_PROD", true);
    expect(w.state.tables.explicit).toEqual([]);
    expect(w.state.tables.manual).toEqual([]);
    expect(w.state.tables.fkClosure).toEqual([]);
    expect(w.state.tables.available).toEqual([]);
    expect(w.state.review.dryRunStatus).toBe("idle");
  });

  it("re-confirming the SAME source preserves table picks", () => {
    const w = createPublishWizard();
    w.setSource("conn-1", "HR_DEV", true);
    w.addExplicitTable("EMPLOYEES");
    w.setSource("conn-1", "HR_DEV", true);
    expect(w.state.tables.explicit.map((t) => t.name)).toEqual(["EMPLOYEES"]);
  });

  it("back() from Step 4 resets dryRunStatus so the next visit re-fires the review", () => {
    const w = createPublishWizard();
    w.setSource("conn-1", "HR_DEV", true);
    w.next();
    w.addExplicitTable("ORDERS");
    w.next();
    w.setSpec({ sandboxName: "X", ttlDays: 7, piiLevel: 2 });
    w.next();
    expect(w.state.currentStep).toBe(4);
    w.setDryRunStatus("ok");
    w.state.review.piiSuggestions = [
      { table: "ORDERS", column: "EMAIL", signal: "column-name", category: "email", suggestedMask: "HASH", confidence: 1 },
    ];
    w.back();
    expect(w.state.currentStep).toBe(3);
    expect(w.state.review.dryRunStatus).toBe("idle");
    expect(w.state.review.piiSuggestions).toEqual([]);
  });

  it("rejects ttlDays out of [1,90] range", () => {
    const w = createPublishWizard();
    w.setSpec({ sandboxName: "X", ttlDays: 0, piiLevel: 2 });
    expect(w.state.spec.ttlDays).toBe(1);
    w.setSpec({ sandboxName: "X", ttlDays: 91, piiLevel: 2 });
    expect(w.state.spec.ttlDays).toBe(90);
  });

  it("clamps fkDepth to [1,5]", () => {
    const w = createPublishWizard();
    w.setFkDepth(0);
    expect(w.state.tables.fkDepth).toBe(1);
    w.setFkDepth(99);
    expect(w.state.tables.fkDepth).toBe(5);
  });

  it("excluded set affects effective table list", () => {
    const w = createPublishWizard();
    w.addExplicitTable("ORDERS");
    w.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        { name: "CUSTOMERS", depth: 1, viaFk: { fromTable: "ORDERS", fromColumns: ["CUSTOMER_ID"], toColumns: ["ID"] } },
      ],
      edges: [],
    });
    expect(w.effectiveTables().map((t) => t.name)).toEqual(["ORDERS", "CUSTOMERS"]);
    w.excludeTable("CUSTOMERS");
    expect(w.effectiveTables().map((t) => t.name)).toEqual(["ORDERS"]);
  });

  it("dedupes a table that is both explicit and reached via FK closure", () => {
    const w = createPublishWizard();
    w.addExplicitTable("ORDERS");
    w.addExplicitTable("EMPLOYEES");
    // FK walk re-discovers EMPLOYEES at depth 1 because ORDERS has an
    // FK pointing at it. Without dedup, effectiveTables would emit
    // EMPLOYEES twice and break Svelte's {#each (t.name)} keyed iter.
    w.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        { name: "EMPLOYEES", depth: 0 },
        { name: "EMPLOYEES", depth: 1, viaFk: { fromTable: "ORDERS", fromColumns: ["EMP_ID"], toColumns: ["ID"] } },
      ],
      edges: [],
    });
    const names = w.effectiveTables().map((t) => t.name);
    expect(names).toEqual(["ORDERS", "EMPLOYEES"]);
    expect(names.filter((n) => n === "EMPLOYEES")).toHaveLength(1);
    // Explicit wins — depth should be 0, origin "explicit", not "fk".
    const employees = w.effectiveTables().find((t) => t.name === "EMPLOYEES")!;
    expect(employees.depth).toBe(0);
    expect(employees.origin).toBe("explicit");
  });

  it("hasE2eExclusionWarning returns true after excluding an FK-pulled table", () => {
    const w = createPublishWizard();
    w.addExplicitTable("ORDERS");
    w.applyFkClosure({
      entries: [
        { name: "ORDERS", depth: 0 },
        { name: "CUSTOMERS", depth: 1 },
      ],
      edges: [],
    });
    expect(w.hasE2eExclusionWarning()).toBe(false);
    w.excludeTable("CUSTOMERS");
    expect(w.hasE2eExclusionWarning()).toBe(true);
  });
});
