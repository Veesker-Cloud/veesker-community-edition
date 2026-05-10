// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { parseRequest, makeError } from "./rpc";
import { dispatch, type HandlerMap } from "./handlers";
import { log } from "./logger";
import { embedText, type EmbedParams } from "./embedding";
import {
  tryEnableThickMode,
  getDriverMode,
  connectionTest,
  openSession,
  closeSession,
  setSessionAction,
  schemaList,
  objectsList,
  tableDescribe,
  queryExecute,
  queryCancel,
  compileErrors,
  objectDdl,
  objectsListPlsql,
  objectDataflow,
  connectionCommit,
  connectionRollback,
  connectionTxState,
  tableRelated,
  tableCountRows,
  objectsSearch,
  schemaKindCounts,
  vectorTablesInSchema,
  vectorIndexList,
  vectorSimilaritySearch,
  vectorCreateIndex,
  vectorDropIndex,
  embedCountPending,
  embedBatch,
  explainPlan,
  procDescribe,
  procExecute,
  dmlPreview,
  querySessionSelf,
  enableDbmsOutputForActiveSession,
  unlockUnsafeDml,
  mviewDetails,
  mviewRefresh,
  synonymDetails,
  dbLinksList,
  dbLinkDdl,
  directoriesList,
  directoryDetails,
} from "./oracle";
import { aiChat, aiSuggestEndpoint } from "./ai";
import { resolveApproval } from "./ai-approval-state";
// L2.1: read session safety (PSDPM flag) and reject embed.batch when active.
import { getSessionSafety } from "./state";
import { RpcCodedError, PSDPM_BLOCKED, APPROVAL_UNKNOWN_REQUEST_ID, ENV_REQUIRED } from "./errors";
import { chartConfigure, chartReset } from "./chart";
import { ordsDetect, ordsModulesList, ordsModuleGet, ordsEnableSchema, ordsModuleExportSql, ordsRolesList, ordsGenerateSql, ordsApply, ordsClientsList, ordsClientsCreate, ordsClientsRevoke } from "./ords";
import {
  debugOpen,
  debugGetSource,
  debugStart,
  debugStop,
  debugStepInto,
  debugStepOver,
  debugStepOut,
  debugContinue,
  debugSetBreakpoint,
  debugRemoveBreakpoint,
  debugGetValues,
  debugGetCallStack,
  debugRun,
} from "./debug";
import { traceProc, explainPlanFlow } from "./flow";
import { tablesStats } from "./perf-stats";

const handlers: HandlerMap = {
  "connection.test": (params) => connectionTest(params as any),
  "workspace.open": async (params) => {
    // Security item #1: every connection must declare an env before connecting.
    // The sidecar is the last line of defence — the UI should never call this
    // without an env, but we enforce it here so no UI bypass is possible.
    const envValue = (params as any)?.env;
    const validEnvs = ["dev", "staging", "prod", "local"];
    if (!envValue || !validEnvs.includes(envValue)) {
      throw new RpcCodedError(
        ENV_REQUIRED,
        "Connection has no environment tag. Set env to dev / staging / prod / local before connecting."
      );
    }
    const result = await openSession(params as any);
    // L3.3 — wire DBMS_OUTPUT on every fresh session so PUT_LINE works without
    // a separate user gesture. Best-effort: failures here never break the open.
    await enableDbmsOutputForActiveSession();
    return result;
  },
  "workspace.close": () => closeSession(),
  "workspace.unlockUnsafeDml": (params) => unlockUnsafeDml(params as any),
  "oracle.session_dbms_output_enable": async () => {
    await enableDbmsOutputForActiveSession();
    return { ok: true };
  },
  "session.setAction": async (params: any) => {
    const action = String(params?.action ?? "SQL Editor");
    await setSessionAction(action);
    return { ok: true };
  },
  "schema.list": () => schemaList(),
  "objects.list": (params) => objectsList(params as any),
  "objects.list.dblinks": (params) => dbLinksList(params as any),
  "objects.list.directories": () => directoriesList(),
  "directory.details": (params) => directoryDetails(params as any),
  "mview.details": (params) => mviewDetails(params as any),
  "mview.refresh": (params) => mviewRefresh(params as any),
  "synonym.details": (params) => synonymDetails(params as any),
  "object.ddl.dblink": (params) => dbLinkDdl(params as any),
  "table.describe": (params) => tableDescribe(params as any),
  "query.execute": (params) => queryExecute(params as any),
  "query.cancel": (params) => queryCancel(params as any),
  "compile.errors": (params) => compileErrors(params as any),
  "object.ddl": (params) => objectDdl(params as any),
  "objects.list.plsql": (params) => objectsListPlsql(params as any),
  "object.dataflow": (params) => objectDataflow(params as any),
  "table.related": (params) => tableRelated(params as any),
  "table.count_rows": (params) => tableCountRows(params as any),
  "connection.commit": () => connectionCommit(),
  "connection.rollback": () => connectionRollback(),
  "connection.txState": () => connectionTxState(),
  "objects.search": (params) => objectsSearch(params as any),
  "schema.kind_counts": (params) => schemaKindCounts(params as any),
  "vector.tables_in_schema": (params) => vectorTablesInSchema(params as any),
  "vector.index_list": (params) => vectorIndexList(params as any),
  "vector.search": async (params: any) => {
    const { embed, owner, tableName, columnName, distanceMetric, limit, withVectors } = params;
    const vector = await embedText(embed as EmbedParams);
    return vectorSimilaritySearch({ owner, tableName, columnName, vector, distanceMetric: distanceMetric ?? "COSINE", limit: limit ?? 10, withVectors: !!withVectors });
  },
  "vector.create_index": (params) => vectorCreateIndex(params as any),
  "vector.drop_index": (params) => vectorDropIndex(params as any),
  "embed.count_pending": (params) => embedCountPending(params as any),
  "embed.batch": (params) => embedBatch(params as any),
  "ai.chat": (params) => aiChat(params as any, false),
  "ai.suggest_endpoint": (params) => aiSuggestEndpoint(params as any),
  // L3.6 (Sprint C Onda 3): host UI calls this once the user has clicked
  // Approve / Approve-for-turn / Deny on a pending tool-call. The matching
  // requestApproval Promise inside the AI tool-use loop unblocks. Unknown
  // requestIds (already resolved or timed out) raise -32036 so the renderer
  // can surface a clean error rather than a silent no-op.
  "ai.approval.resolve": async (params: any) => {
    const requestId = String(params?.requestId ?? "");
    const approved = !!params?.approved;
    const applyToTurn = !!params?.applyToTurn;
    if (!requestId) {
      throw new RpcCodedError(
        APPROVAL_UNKNOWN_REQUEST_ID,
        "approval_unknown_request_id"
      );
    }
    const found = resolveApproval(requestId, { approved, applyToTurn });
    if (!found) {
      throw new RpcCodedError(
        APPROVAL_UNKNOWN_REQUEST_ID,
        "approval_unknown_request_id"
      );
    }
    return { ok: true };
  },
  "explain.plan": (params) => explainPlan(params as any),
  "oracle.session_self": () => querySessionSelf(),
  "proc.describe": (params) => procDescribe(params as any),
  "proc.execute": (params) => procExecute(params as any),
  "chart.configure": (params) => chartConfigure(params as any),
  "chart.reset":     (params) => chartReset(params as any),
  "ords.detect":        (params) => ordsDetect(params as any),
  "ords.modules.list":  (params) => ordsModulesList(params as any),
  "ords.module.get":    (params) => ordsModuleGet(params as any),
  "ords.enable_schema": (params) => ordsEnableSchema(params as any),
  "ords.module.export_sql": (params) => ordsModuleExportSql(params as any),
  "ords.roles.list":     (params) => ordsRolesList(params as any),
  "ords.generate_sql":   (params) => ordsGenerateSql(params as any),
  "ords.apply":          (params) => ordsApply(params as any),
  "ords.clients.list":   (params) => ordsClientsList(params as any),
  "ords.clients.create": (params) => ordsClientsCreate(params as any),
  "ords.clients.revoke": (params) => ordsClientsRevoke(params as any),
  "debug.open":              (params) => debugOpen(params as any),
  "debug.get_source":        (params) => debugGetSource(params as any),
  "debug.start":             (params) => debugStart(params as any),
  "debug.stop":              () => debugStop(),
  "debug.step_into":         () => debugStepInto(),
  "debug.step_over":         () => debugStepOver(),
  "debug.step_out":          () => debugStepOut(),
  "debug.continue":          () => debugContinue(),
  "debug.set_breakpoint":    (params) => debugSetBreakpoint(params as any),
  "debug.remove_breakpoint": (params) => debugRemoveBreakpoint(params as any),
  "debug.get_values":        (params) => debugGetValues(params as any),
  "debug.get_call_stack":    () => debugGetCallStack(),
  "debug.run":               (params) => debugRun(params as any),
  "flow.trace_proc": (params) => traceProc(params as any),
  "flow.trace_sql":  (params) => explainPlanFlow(params as any),
  "perf.stats": (params) => tablesStats(params as any),
  "dml.preview": async (p) => dmlPreview((p as any).sql ?? ""),
  "driver.mode": async () => ({ mode: getDriverMode() }),
  ping: async () => ({ pong: true }),
};

function writeLine(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Enable Thick mode at startup if Oracle Instant Client is available; falls back
// to Thin mode silently if not. Thick mode supports legacy password verifiers
// (NJS-116 errors) that older databases (9i/10g/11g) may still expose.
tryEnableThickMode();

async function main() {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as any) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const req = parseRequest(line);
      if (!req) {
        writeLine(makeError(null, -32700, "Parse error"));
        continue;
      }
      // Fire-and-forget: allows debug.stop to interrupt a blocking debug.start
      dispatch(handlers, req)
        .then(writeLine)
        .catch((err) => writeLine(makeError(req.id, -32603, String(err))));
    }
  }
}

main()
  .then(() => gracefulExit(0))
  .catch((err) => {
    log.error(`sidecar fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    gracefulExit(1);
  });

let _exiting = false;
async function gracefulExit(code: number): Promise<never> {
  if (_exiting) process.exit(code);
  _exiting = true;
  // Best-effort: close the active Oracle session so it doesn't linger
  // server-side until the idle timeout. Bounded to 2s so a hung close
  // doesn't keep the sidecar alive.
  try {
    await Promise.race([
      closeSession(),
      new Promise((res) => setTimeout(res, 2000)),
    ]);
  } catch {
    // closeSession is already best-effort internally.
  }
  process.exit(code);
}

process.on("SIGTERM", () => { void gracefulExit(0); });
process.on("SIGINT",  () => { void gracefulExit(0); });
