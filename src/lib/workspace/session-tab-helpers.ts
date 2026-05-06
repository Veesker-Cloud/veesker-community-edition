export type SessionErrorKind = "missing_privilege" | "transient";

export type MappedSessionError = {
  kind: SessionErrorKind;
  grant?: string;
  oracleCode?: number;
  message?: string;
};

export function mapSessionError(err: unknown): MappedSessionError {
  const e = err as {
    data?: { kind?: string; grant?: string; oracleCode?: number };
    message?: string;
  };
  const kind = e?.data?.kind;
  if (kind === "missing_privilege") {
    return {
      kind: "missing_privilege",
      grant: e?.data?.grant,
    };
  }
  return {
    kind: "transient",
    oracleCode: e?.data?.oracleCode,
    message: e?.message,
  };
}

export function formatLogonAge(logonIso: string, nowMs: number): string {
  const logonMs = new Date(logonIso).getTime();
  const diffSec = Math.floor((nowMs - logonMs) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

export function semanticColorFor(field: string, value: string): string {
  if (field === "STATUS" && value === "ACTIVE") return "var(--vsk-status-ok)";
  if (field === "STATE" && value.startsWith("WAIT")) return "var(--vsk-status-warn)";
  if (field === "EVENT") return "var(--vsk-status-warn)";
  if (["SID", "SERIAL", "SQL_ID", "CLIENT_IDENTIFIER"].includes(field)) {
    return "var(--vsk-fg-accent)";
  }
  if (["MODULE", "PROGRAM"].includes(field)) return "var(--vsk-fg-info)";
  return "var(--vsk-fg-muted)";
}
