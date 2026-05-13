interface ColumnDescriptor {
  name: string;
  dataType: string;
}

export interface ColumnTypeIssue {
  table: string;
  column: string;
  oracleType: string;
  fatal: boolean;
  message: string;
}

export interface TypeGuardReport {
  hasFatal: boolean;
  issues: ColumnTypeIssue[];
}

const FATAL_TYPES: ReadonlySet<string> = new Set([
  "XMLTYPE",
  "ANYTYPE",
  "ANYDATA",
  "ANYDATASET",
  "BFILE",
  "URITYPE",
  "HTTPURITYPE",
  "XDBURITYPE",
  "DBURITYPE",
]);

function classifyType(oracleType: string): { fatal: boolean; message: string } | null {
  const t = oracleType.trim().toUpperCase();
  if (t === "") return null;

  if (FATAL_TYPES.has(t)) {
    return {
      fatal: true,
      message: `Oracle type "${oracleType}" cannot be serialized to Parquet. Use a view to cast it (e.g. XMLTYPE → CLOB via .getClobVal()) or exclude this column.`,
    };
  }

  if (t === "NUMBER" || t === "FLOAT") {
    return {
      fatal: false,
      message: `Bare ${oracleType} without precision/scale is mapped to DECIMAL(38,18). Values with fractional scale >18 will be silently truncated.`,
    };
  }

  const numMatch = t.match(/^NUMBER\s*\(\s*\d+\s*,\s*(-?\d+)\s*\)$/);
  if (numMatch) {
    const scale = parseInt(numMatch[1]!, 10);
    if (scale > 18) {
      return {
        fatal: false,
        message: `${oracleType} has scale ${scale} which exceeds DuckDB DECIMAL maximum of 18. Values will be stored as DECIMAL(38,18) with scale truncated at position 18.`,
      };
    }
    return null;
  }

  if (/WITH\s+(LOCAL\s+)?TIME\s+ZONE/i.test(t)) {
    return {
      fatal: false,
      message: `${oracleType}: timezone offset may be lost. oracledb Thin mode normalizes to UTC and discards session timezone. Stored as TIMESTAMPTZ.`,
    };
  }

  if (t === "CLOB" || t === "NCLOB") {
    return {
      fatal: false,
      message: `${oracleType} is mapped to VARCHAR. Values exceeding 1 MB may be truncated by the oracledb Thin mode LOB streaming limit.`,
    };
  }

  if (t === "LONG") {
    return {
      fatal: false,
      message: `LONG is a deprecated Oracle type mapped to VARCHAR. Content exceeding 32767 bytes will be truncated. Consider migrating to CLOB.`,
    };
  }

  if (/^LONG\s+RAW$/.test(t)) {
    return {
      fatal: false,
      message: `LONG RAW is a deprecated Oracle type mapped to BLOB. Data is preserved as binary but the column type should be migrated to BLOB.`,
    };
  }

  if (t.startsWith("INTERVAL")) {
    return {
      fatal: false,
      message: `${oracleType} is mapped to VARCHAR as its ISO 8601 string representation. Interval arithmetic will not be available in the sandbox.`,
    };
  }

  return null;
}

export function guardColumnTypes(
  schemas: Record<string, ColumnDescriptor[]>,
): TypeGuardReport {
  const issues: ColumnTypeIssue[] = [];

  for (const [table, columns] of Object.entries(schemas)) {
    for (const col of columns) {
      const result = classifyType(col.dataType);
      if (result !== null) {
        issues.push({ table, column: col.name, oracleType: col.dataType, ...result });
      }
    }
  }

  return { hasFatal: issues.some((i) => i.fatal), issues };
}

export function formatTypeGuardError(report: TypeGuardReport): string {
  const fatal = report.issues.filter((i) => i.fatal);
  const warns = report.issues.filter((i) => !i.fatal);

  const lines: string[] = [
    `Sandbox build blocked: ${fatal.length} unsupported column type${fatal.length !== 1 ? "s" : ""} found.`,
    "",
    "FATAL (must resolve before building):",
  ];

  for (const issue of fatal) {
    lines.push(`  • ${issue.table}.${issue.column} [${issue.oracleType}]: ${issue.message}`);
  }

  if (warns.length > 0) {
    lines.push(
      "",
      `WARNINGS (${warns.length} additional issue${warns.length !== 1 ? "s" : ""} — build will proceed but data may be imprecise):`,
    );
    for (const issue of warns) {
      lines.push(`  • ${issue.table}.${issue.column} [${issue.oracleType}]: ${issue.message}`);
    }
  }

  return lines.join("\n");
}
