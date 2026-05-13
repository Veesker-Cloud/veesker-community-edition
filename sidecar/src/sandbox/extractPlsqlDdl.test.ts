import { describe, expect, it } from "bun:test";
import { extractPlsqlDdl, type DdlExtractFn, type DdlExtractInput } from "./extractPlsqlDdl";

const fakeExtractor =
  (responses: Record<string, { ddl: string; spec?: string; body?: string } | { error: string }>): DdlExtractFn =>
  async (i: DdlExtractInput) => {
    const key = `${i.kind}:${i.owner}.${i.name}`;
    const r = responses[key];
    if (!r) throw new Error(`unexpected extractor call for ${key}`);
    if ("error" in r) throw new Error(r.error);
    return r;
  };

describe("extractPlsqlDdl", () => {
  it("extracts DDL for a procedure", async () => {
    const extractor = fakeExtractor({
      "PROCEDURE:HR.GET_EMP": { ddl: "CREATE PROCEDURE get_emp AS BEGIN NULL; END;" },
    });
    const objects = [{ kind: "PROCEDURE" as const, owner: "HR", name: "GET_EMP", refPath: ["EMP", "GET_EMP"] }];
    const r = await extractPlsqlDdl(extractor, objects, () => {});
    expect(r.sourceRows).toHaveLength(1);
    expect(r.sourceRows[0]?.ddl).toContain("get_emp");
    expect(r.objectRows).toHaveLength(1);
    expect(r.objectRows[0]?.status).toBe("VALID");
    expect(r.skipped).toEqual([]);
  });

  it("emits PACKAGE rows with spec + body columns", async () => {
    const extractor = fakeExtractor({
      "PACKAGE:HR.MYPKG": {
        ddl: "CREATE PACKAGE mypkg AS ... END;\nCREATE PACKAGE BODY mypkg AS ... END;",
        spec: "CREATE PACKAGE mypkg AS ... END;",
        body: "CREATE PACKAGE BODY mypkg AS ... END;",
      },
    });
    const r = await extractPlsqlDdl(
      extractor,
      [{ kind: "PACKAGE" as const, owner: "HR", name: "MYPKG", refPath: ["EMP", "MYPKG"] }],
      () => {},
    );
    expect(r.sourceRows[0]?.spec).toBeDefined();
    expect(r.sourceRows[0]?.body).toBeDefined();
    expect(r.sourceRows[0]?.ddl).toBe("");
  });

  it("accumulates skippedObjects on extractor errors", async () => {
    const extractor = fakeExtractor({
      "PROCEDURE:HR.OK":  { ddl: "..." },
      "PROCEDURE:HR.BAD": { error: "ORA-31603: object not found" },
    });
    const r = await extractPlsqlDdl(
      extractor,
      [
        { kind: "PROCEDURE" as const, owner: "HR", name: "OK",  refPath: [] },
        { kind: "PROCEDURE" as const, owner: "HR", name: "BAD", refPath: [] },
      ],
      () => {},
    );
    expect(r.sourceRows).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.name).toBe("BAD");
    expect(r.skipped[0]?.reason).toBe("EXTRACTION_ERROR");
    expect(r.skipped[0]?.detail).toContain("ORA-31603");
  });

  it("classifies privilege errors as NO_PRIVILEGE", async () => {
    const extractor = fakeExtractor({
      "FUNCTION:HR.SECRET": { error: "ORA-01031: insufficient privileges" },
    });
    const r = await extractPlsqlDdl(
      extractor,
      [{ kind: "FUNCTION" as const, owner: "HR", name: "SECRET", refPath: [] }],
      () => {},
    );
    expect(r.skipped[0]?.reason).toBe("NO_PRIVILEGE");
  });

  it("classifies object-visibility errors (ORA-00942) as NO_PRIVILEGE", async () => {
    const extractor = fakeExtractor({
      "PROCEDURE:HR.HIDDEN": { error: "ORA-00942: table or view does not exist" },
    });
    const r = await extractPlsqlDdl(
      extractor,
      [{ kind: "PROCEDURE" as const, owner: "HR", name: "HIDDEN", refPath: [] }],
      () => {},
    );
    expect(r.skipped[0]?.reason).toBe("NO_PRIVILEGE");
  });

  it("emits progress events as objects extract", async () => {
    const extractor = fakeExtractor({
      "PROCEDURE:HR.A": { ddl: "..." },
      "PROCEDURE:HR.B": { ddl: "..." },
    });
    const events: Array<{ done: number; total: number }> = [];
    await extractPlsqlDdl(
      extractor,
      [
        { kind: "PROCEDURE" as const, owner: "HR", name: "A", refPath: [] },
        { kind: "PROCEDURE" as const, owner: "HR", name: "B", refPath: [] },
      ],
      (e) => events.push(e),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ done: 1, total: 2 });
    expect(events[1]).toEqual({ done: 2, total: 2 });
  });
});
