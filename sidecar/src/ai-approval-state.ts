// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { emitNotification } from "./notifications";

export type ApprovalDecision = { approved: boolean; applyToTurn: boolean };

// Five minutes. Exported so tests can override via dependency injection if
// needed; the real RPC handler always uses this default.
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

type Resolver = (decision: ApprovalDecision) => void;

const pending = new Map<string, Resolver>();

// Register a pending approval, emit a notification frame asking the host UI
// for a decision, and return a Promise that resolves when:
//   - resolveApproval(requestId, decision) is called, or
//   - the timeout fires (auto-deny + cleanup to prevent Map leak).
export function requestApproval(
  requestId: string,
  tool: string,
  input: unknown,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      // Only resolve+cleanup if no one beat us to it. Without this guard a
      // late-firing timer after resolveApproval could double-resolve... which
      // is harmless for Promises but the Map.delete would still be wasted.
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve({ approved: false, applyToTurn: false });
      }
    }, timeoutMs);

    pending.set(requestId, (decision) => {
      clearTimeout(timer);
      resolve(decision);
    });

    emitNotification("ai.approval.request", { requestId, tool, input });
  });
}

// Look up the resolver, deliver the decision, drop the Map entry. Returns
// false when the requestId is unknown (already resolved, never registered, or
// already timed out) so the caller can surface an RPC error.
export function resolveApproval(
  requestId: string,
  decision: ApprovalDecision,
): boolean {
  const resolver = pending.get(requestId);
  if (!resolver) return false;
  pending.delete(requestId);
  resolver(decision);
  return true;
}

// Test-only: drop all pending approvals without firing their resolvers.
// Exported so test files can isolate their own state between cases.
export function _resetApprovalsForTest(): void {
  pending.clear();
}
