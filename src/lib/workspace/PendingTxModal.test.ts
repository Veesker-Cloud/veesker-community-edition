// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-cloud-edition

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  connectionTxState: vi.fn(),
  connectionCommit: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  connectionRollback: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  txKeepOpenRecord: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  txKeepOpenClear: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  txModalAudit: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("$lib/workspace", async (importOriginal) => {
  const mod = await importOriginal<typeof import("$lib/workspace")>();
  return {
    ...mod,
    connectionTxState: mocks.connectionTxState,
    connectionCommit: mocks.connectionCommit,
    connectionRollback: mocks.connectionRollback,
    txKeepOpenRecord: mocks.txKeepOpenRecord,
    txKeepOpenClear: mocks.txKeepOpenClear,
    txModalAudit: mocks.txModalAudit,
  };
});

import PendingTxModal, {
  type ConnectionRow,
  type PerRowDecision,
} from "./PendingTxModal.svelte";
import { TxModalController } from "./tx-modal-controller";

const rowDev: ConnectionRow = {
  connectionId: "conn-dev",
  connectionName: "OracleDev",
  env: "dev",
  pendingStatements: 3,
  lastTxId: "0001",
  lastModifyingType: "dml",
};
const rowProd: ConnectionRow = {
  connectionId: "conn-prod",
  connectionName: "OraclePROD",
  env: "prod",
  pendingStatements: 12,
  lastTxId: "0042",
  lastModifyingType: "dml",
};
const rowStaging: ConnectionRow = {
  connectionId: "conn-staging",
  connectionName: "OracleSTG",
  env: "staging",
  pendingStatements: 5,
  lastTxId: "0010",
  lastModifyingType: "ddl",
};

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    if (typeof (m as { mockReset?: () => void }).mockReset === "function") {
      (m as { mockReset: () => void }).mockReset();
    }
  }
  mocks.connectionTxState.mockResolvedValue({
    ok: true,
    data: {
      hasOpenTx: true,
      pendingStatements: 12,
      lastTxId: "0042",
      lastModifyingAt: Date.now(),
      lastModifyingType: "dml",
    },
  });
  mocks.connectionCommit.mockResolvedValue({ ok: true, data: undefined });
  mocks.connectionRollback.mockResolvedValue({ ok: true, data: undefined });
  mocks.txKeepOpenRecord.mockResolvedValue({ ok: true, data: {} });
  mocks.txKeepOpenClear.mockResolvedValue({ ok: true, data: undefined });
  mocks.txModalAudit.mockResolvedValue({ ok: true, data: undefined });
});

describe("PendingTxModal — 9 scenarios", () => {
  // 1. Renders one row per connection
  it("[1] renders one row per connection in the array", async () => {
    const onDecide = vi.fn();
    const onCancel = vi.fn();
    render(PendingTxModal, {
      props: { connections: [rowDev, rowProd], onDecide, onCancel },
    });
    await tick();
    expect(screen.getByTestId("row-conn-dev")).toBeInTheDocument();
    expect(screen.getByTestId("row-conn-prod")).toBeInTheDocument();
  });

  // 2. PROD row exposes the keep-open dropdown
  it("[2] PROD shows keep-open dropdown; non-PROD does not", async () => {
    render(PendingTxModal, {
      props: {
        connections: [rowDev, rowProd],
        onDecide: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    await tick();
    expect(screen.getByTestId("keep-open-conn-prod")).toBeInTheDocument();
    expect(screen.queryByTestId("keep-open-conn-dev")).toBeNull();
  });

  // 3. COMMIT ALL is disabled when staging or prod is in the list
  it("[3] COMMIT ALL disabled when staging/prod present, enabled when only dev/local", async () => {
    const { unmount } = render(PendingTxModal, {
      props: {
        connections: [rowDev, rowProd],
        onDecide: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    await tick();
    const commitAllProd = screen.getByTestId("commit-all") as HTMLButtonElement;
    expect(commitAllProd.disabled).toBe(true);
    unmount();

    render(PendingTxModal, {
      props: {
        connections: [rowDev],
        onDecide: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    await tick();
    const commitAllDev = screen.getByTestId("commit-all") as HTMLButtonElement;
    expect(commitAllDev.disabled).toBe(false);
  });

  // 4. Cancel button fires onCancel
  it("[4] clicking Cancelar fires onCancel callback", async () => {
    const onCancel = vi.fn();
    render(PendingTxModal, {
      props: { connections: [rowDev], onDecide: vi.fn(), onCancel },
    });
    await tick();
    await fireEvent.click(screen.getByTestId("cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // 5. ESC and click-outside do NOT dismiss
  it("[5] ESC and click on overlay do not call onCancel", async () => {
    const onCancel = vi.fn();
    render(PendingTxModal, {
      props: { connections: [rowProd], onDecide: vi.fn(), onCancel },
    });
    await tick();
    await fireEvent.keyDown(window, { key: "Escape" });
    await fireEvent.click(screen.getByTestId("pending-tx-overlay"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  // 6. Apply blocked until every row has a decision
  it("[6] Apply button stays disabled until every row decided", async () => {
    render(PendingTxModal, {
      props: {
        connections: [rowDev, rowStaging],
        onDecide: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    await tick();
    const apply = screen.getByTestId("apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await fireEvent.click(screen.getByTestId("rollback-conn-dev"));
    await tick();
    expect(apply.disabled).toBe(true);
    await fireEvent.click(screen.getByTestId("rollback-conn-staging"));
    await tick();
    expect(apply.disabled).toBe(false);
  });

  // 7. Per-row decisions flow through the onDecide callback
  it("[7] per-row commit/rollback/keep_open delivered through onDecide", async () => {
    const onDecide = vi.fn();
    render(PendingTxModal, {
      props: {
        connections: [rowDev, rowProd],
        onDecide,
        onCancel: vi.fn(),
      },
    });
    await tick();
    await fireEvent.click(screen.getByTestId("commit-conn-dev"));
    await fireEvent.click(screen.getByTestId("keep-open-apply-conn-prod"));
    await tick();
    await fireEvent.click(screen.getByTestId("apply"));
    expect(onDecide).toHaveBeenCalledTimes(1);
    const decisions = onDecide.mock.calls[0][0] as Record<string, PerRowDecision>;
    expect(decisions["conn-dev"]).toEqual({ kind: "commit" });
    expect(decisions["conn-prod"].kind).toBe("keep_open");
  });

  // 8. Controller.applyDecisions issues commit/rollback + audit + keep_open clear
  it("[8] applyDecisions calls connectionCommit/Rollback + audit + clear in order", async () => {
    const ctrl = new TxModalController();
    await ctrl.applyDecisions(
      {
        "conn-dev": { kind: "commit" },
        "conn-prod": { kind: "rollback" },
      },
      [rowDev, rowProd],
      "window_close",
    );
    expect(mocks.connectionCommit).toHaveBeenCalledTimes(1);
    expect(mocks.connectionRollback).toHaveBeenCalledTimes(1);
    expect(mocks.txKeepOpenClear).toHaveBeenCalledTimes(2);
    expect(mocks.txModalAudit).toHaveBeenCalledTimes(2);
    const auditCalls = mocks.txModalAudit.mock.calls.map((c) => c[0]);
    expect(auditCalls[0]).toMatchObject({
      decision: "tx_modal_commit",
      triggeredBy: "window_close",
      connectionId: "conn-dev",
    });
    expect(auditCalls[1]).toMatchObject({
      decision: "tx_modal_rollback",
      triggeredBy: "window_close",
      connectionId: "conn-prod",
    });
  });

  // 9. recordCancel arms idle reminders for PROD only and fires at 5/10/20/40 min
  it("[9] cancel arms PROD idle reminder; fires at 5 then 10 minute thresholds", async () => {
    const ctrl = new TxModalController();
    const onTick = vi.fn();
    await ctrl.recordCancel([rowDev, rowProd], "window_close", onTick);
    expect(ctrl._peekIdle().armed).toBe(true);
    expect(ctrl._peekIdle().triggeredBy).toBe("window_close");

    const start = ctrl._peekIdle().startedAt;
    ctrl.checkIdleThresholds(start + 4 * 60_000);
    expect(onTick).not.toHaveBeenCalled();
    ctrl.checkIdleThresholds(start + 5 * 60_000);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0].connectionId).toBe("conn-prod");
    expect(onTick.mock.calls[0][1]).toBe(5);
    ctrl.checkIdleThresholds(start + 10 * 60_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick.mock.calls[1][1]).toBe(10);

    const auditCalls = mocks.txModalAudit.mock.calls.map((c) => c[0]);
    expect(auditCalls.every((a) => a.decision === "tx_modal_close_cancelled")).toBe(true);
    expect(auditCalls.every((a) => a.triggeredBy === "window_close")).toBe(true);

    ctrl.stopReminders();
    expect(ctrl._peekIdle().armed).toBe(false);
  });
});
