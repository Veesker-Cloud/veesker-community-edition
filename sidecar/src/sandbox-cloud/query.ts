import { getSession } from "./session";

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  row_count: number;
  elapsed_ms: number;
}

export interface QuerySandboxParams {
  sandboxId: string;
  sql: string;
}

export class NotOpenError extends Error {
  constructor(sandboxId: string) {
    super(`Sandbox ${sandboxId} is not open`);
    this.name = "NotOpenError";
  }
}

const queueByBox = new Map<string, Promise<unknown>>();

async function withSandboxLock<T>(sandboxId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queueByBox.get(sandboxId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => { release = resolve; });
  queueByBox.set(sandboxId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (queueByBox.get(sandboxId) === next) queueByBox.delete(sandboxId);
  }
}

export async function querySandbox(params: QuerySandboxParams): Promise<QueryResult> {
  const session = getSession(params.sandboxId);
  if (!session) throw new NotOpenError(params.sandboxId);

  return await withSandboxLock(params.sandboxId, async () => {
    const start = performance.now();
    const rawRows = await session.duckHost.query(params.sql);
    const elapsed_ms = Math.round(performance.now() - start);

    if (rawRows.length === 0) {
      return { columns: [], rows: [], row_count: 0, elapsed_ms };
    }

    const first = rawRows[0] as Record<string, unknown>;
    const columnNames = Object.keys(first);
    const columns: QueryColumn[] = columnNames.map((name) => ({
      name,
      type: typeOf(first[name]),
    }));
    const rows = rawRows.map((row) =>
      columnNames.map((c) => (row as Record<string, unknown>)[c]),
    );

    return { columns, rows, row_count: rows.length, elapsed_ms };
  });
}

function typeOf(v: unknown): string {
  if (v === null || v === undefined) return "UNKNOWN";
  if (typeof v === "bigint") return "BIGINT";
  if (typeof v === "number") return Number.isInteger(v) ? "INTEGER" : "DOUBLE";
  if (typeof v === "string") return "VARCHAR";
  if (typeof v === "boolean") return "BOOLEAN";
  if (v instanceof Date) return "TIMESTAMP";
  if (v instanceof Uint8Array) return "BLOB";
  return "VARCHAR";
}
