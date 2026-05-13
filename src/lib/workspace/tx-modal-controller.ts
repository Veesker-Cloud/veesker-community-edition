// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-cloud-edition

// Item #4 Phase C — TX modal controller.
//
// Orchestrates the decision flow that PendingTxModal renders. The controller
// is the single point that:
//   - reads authoritative TX state from the sidecar (single-session today)
//   - issues commit / rollback / keep_open per connection
//   - fires the audit row (origin = decision, triggered_by = caller-supplied)
//   - arms the 5-min idle reminder for PROD rows the user cancelled
//
// Phase D will call `buildSnapshot` from each of the 5 close-paths
// (window close, tab close, route navigate, tray quit, session lost) and
// pass the matching `triggeredBy`. Until then the default is `manual_check`.

import {
  connectionCommit,
  connectionRollback,
  connectionTxState,
  txKeepOpenClear,
  txKeepOpenRecord,
  txModalAudit,
  type TxModalDecision,
  type TxModalTriggeredBy,
} from "$lib/workspace";
import type { ConnectionRow, PerRowDecision } from "./PendingTxModal.svelte";

export type ActiveConnectionInfo = {
  connectionId: string;
  connectionName: string;
  env: "local" | "dev" | "staging" | "prod";
};

export type IdleReminderTick = (row: ConnectionRow, minutesElapsed: number) => void;

const PROD_IDLE_REMINDER_THRESHOLDS_MS = [5, 10, 20, 40].map((m) => m * 60_000);

class TxModalController {
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleStartedAt = 0;
  private idleConnections: ConnectionRow[] = [];
  private idleFiredThresholds = new Set<number>();
  private idleTriggeredBy: TxModalTriggeredBy = "manual_check";
  private idleCallback: IdleReminderTick | null = null;

  // Reads txState from sidecar. Returns the connection row only if the
  // sidecar reports an open TX. Empty array means "nothing to decide,
  // caller can proceed without showing the modal".
  async buildSnapshot(active: ActiveConnectionInfo): Promise<ConnectionRow[]> {
    const res = await connectionTxState();
    if (!res.ok) return [];
    const view = res.data;
    if (!view.hasOpenTx || view.pendingStatements <= 0) return [];
    return [
      {
        connectionId: active.connectionId,
        connectionName: active.connectionName,
        env: active.env,
        pendingStatements: view.pendingStatements,
        lastTxId: view.lastTxId,
        lastModifyingType: view.lastModifyingType,
      },
    ];
  }

  async applyDecisions(
    decisions: Record<string, PerRowDecision>,
    connections: ConnectionRow[],
    triggeredBy: TxModalTriggeredBy = "manual_check",
  ): Promise<void> {
    this.stopReminders();
    for (const conn of connections) {
      const dec = decisions[conn.connectionId];
      if (!dec) continue;
      const decisionLabel = decisionToLabel(dec);
      try {
        if (dec.kind === "commit") {
          await connectionCommit();
          await txKeepOpenClear(conn.connectionId);
        } else if (dec.kind === "rollback") {
          await connectionRollback();
          await txKeepOpenClear(conn.connectionId);
        } else {
          const opened = Date.now();
          const expires = opened + dec.minutes * 60_000;
          await txKeepOpenRecord({
            connectionId: conn.connectionId,
            env: conn.env,
            lastTxId: conn.lastTxId,
            openedAt: opened,
            expiresAt: expires,
          });
        }
      } finally {
        await txModalAudit({
          decision: decisionLabel,
          triggeredBy,
          connectionId: conn.connectionId,
          env: conn.env,
          pendingStatements: conn.pendingStatements,
          lastTxId: conn.lastTxId,
        });
      }
    }
  }

  // Logs the cancellation as an audit row (so the trail exists) and arms
  // the idle reminder for PROD rows. Reminder fires at 5/10/20/40 min.
  async recordCancel(
    connections: ConnectionRow[],
    triggeredBy: TxModalTriggeredBy = "manual_check",
    onIdleReminder?: IdleReminderTick,
  ): Promise<void> {
    for (const conn of connections) {
      await txModalAudit({
        decision: "tx_modal_close_cancelled",
        triggeredBy,
        connectionId: conn.connectionId,
        env: conn.env,
        pendingStatements: conn.pendingStatements,
        lastTxId: conn.lastTxId,
      });
    }
    const prodRows = connections.filter((c) => c.env === "prod");
    if (prodRows.length > 0 && onIdleReminder) {
      this.armIdleReminders(prodRows, triggeredBy, onIdleReminder);
    }
  }

  armIdleReminders(
    prodConnections: ConnectionRow[],
    triggeredBy: TxModalTriggeredBy,
    onTick: IdleReminderTick,
  ): void {
    this.stopReminders();
    if (prodConnections.length === 0) return;
    this.idleStartedAt = Date.now();
    this.idleConnections = prodConnections;
    this.idleTriggeredBy = triggeredBy;
    this.idleCallback = onTick;
    this.idleFiredThresholds.clear();
    this.idleTimer = setInterval(() => this.checkIdleThresholds(), 60_000);
  }

  // Exposed for tests so they can drive the timer without sleeping 5 min.
  checkIdleThresholds(now: number = Date.now()): void {
    if (!this.idleCallback) return;
    const elapsed = now - this.idleStartedAt;
    for (const threshold of PROD_IDLE_REMINDER_THRESHOLDS_MS) {
      if (elapsed >= threshold && !this.idleFiredThresholds.has(threshold)) {
        this.idleFiredThresholds.add(threshold);
        const minutes = Math.round(threshold / 60_000);
        for (const row of this.idleConnections) {
          this.idleCallback(row, minutes);
        }
      }
    }
  }

  stopReminders(): void {
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleConnections = [];
    this.idleFiredThresholds.clear();
    this.idleCallback = null;
  }

  // Test-only — exposes internal state without leaking it to runtime.
  _peekIdle(): {
    armed: boolean;
    fired: number[];
    startedAt: number;
    triggeredBy: TxModalTriggeredBy;
  } {
    return {
      armed: this.idleTimer !== null,
      fired: [...this.idleFiredThresholds].map((t) => Math.round(t / 60_000)),
      startedAt: this.idleStartedAt,
      triggeredBy: this.idleTriggeredBy,
    };
  }
}

function decisionToLabel(dec: PerRowDecision): TxModalDecision {
  if (dec.kind === "commit") return "tx_modal_commit";
  if (dec.kind === "rollback") return "tx_modal_rollback";
  return "tx_modal_keep_open";
}

export const txModalController = new TxModalController();
export { TxModalController };
