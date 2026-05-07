// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { CommandParser } from "./parser";
import type { Parsed } from "./types";

function feedAll(parser: CommandParser, lines: string[]): Parsed[] {
  return lines.map((l) => parser.feed(l));
}

describe("CommandParser — blank lines and resets", () => {
  test("blank line outside a block returns blank", () => {
    const p = new CommandParser();
    expect(p.feed("")).toEqual({ kind: "blank" });
    expect(p.feed("   ")).toEqual({ kind: "blank" });
    expect(p.feed("\t  ")).toEqual({ kind: "blank" });
  });

  test("reset clears partial SQL buffer", () => {
    const p = new CommandParser();
    const r1 = p.feed("SELECT * FROM dual");
    expect(r1.kind).toBe("incomplete");
    p.reset();
    expect(p.feed("")).toEqual({ kind: "blank" });
    expect(p.isInBlock()).toBe(false);
  });

  test("reset clears partial PL/SQL block", () => {
    const p = new CommandParser();
    p.feed("BEGIN");
    expect(p.isInBlock()).toBe(true);
    p.reset();
    expect(p.isInBlock()).toBe(false);
    expect(p.feed("")).toEqual({ kind: "blank" });
  });
});

describe("CommandParser — comments", () => {
  test("-- comment outside a block", () => {
    const p = new CommandParser();
    expect(p.feed("-- this is a note")).toEqual({
      kind: "comment",
      raw: "-- this is a note",
    });
  });

  test("REM comment outside a block", () => {
    const p = new CommandParser();
    expect(p.feed("REM hello there")).toEqual({
      kind: "comment",
      raw: "REM hello there",
    });
  });

  test("REMARK comment outside a block", () => {
    const p = new CommandParser();
    expect(p.feed("REMARK something")).toEqual({
      kind: "comment",
      raw: "REMARK something",
    });
  });

  test("rem (lowercase) is a comment", () => {
    const p = new CommandParser();
    expect(p.feed("rem lowercase ok")).toEqual({
      kind: "comment",
      raw: "rem lowercase ok",
    });
  });

  test("leading whitespace before -- still classifies as comment", () => {
    const p = new CommandParser();
    expect(p.feed("   -- indented")).toEqual({
      kind: "comment",
      raw: "   -- indented",
    });
  });

  test("comment lines inside a PL/SQL block are absorbed into the block", () => {
    const p = new CommandParser();
    expect(p.feed("BEGIN").kind).toBe("incomplete");
    expect(p.feed("  -- note inside block").kind).toBe("incomplete");
    expect(p.feed("  NULL;").kind).toBe("incomplete");
    expect(p.feed("END;").kind).toBe("incomplete");
    const final = p.feed("/");
    expect(final.kind).toBe("plsql");
    if (final.kind === "plsql") {
      expect(final.text).toContain("-- note inside block");
      expect(final.text).toContain("END;");
      expect(final.terminator).toBe("/");
    }
  });
});

describe("CommandParser — SQL statements", () => {
  test("single-line SELECT terminates on ;", () => {
    const p = new CommandParser();
    const r = p.feed("SELECT 1 FROM dual;");
    expect(r.kind).toBe("sql");
    if (r.kind === "sql") {
      expect(r.text).toBe("SELECT 1 FROM dual");
      expect(r.terminator).toBe(";");
    }
  });

  test("multi-line SELECT accumulates and emits on final ; line", () => {
    const p = new CommandParser();
    const r1 = p.feed("SELECT *");
    expect(r1.kind).toBe("incomplete");
    if (r1.kind === "incomplete") expect(r1.partial).toContain("SELECT *");

    const r2 = p.feed("FROM employees");
    expect(r2.kind).toBe("incomplete");
    if (r2.kind === "incomplete") {
      expect(r2.partial).toContain("SELECT *");
      expect(r2.partial).toContain("FROM employees");
    }

    const r3 = p.feed("WHERE deptno = 10;");
    expect(r3.kind).toBe("sql");
    if (r3.kind === "sql") {
      expect(r3.text).toContain("SELECT *");
      expect(r3.text).toContain("FROM employees");
      expect(r3.text).toContain("WHERE deptno = 10");
      expect(r3.text.endsWith(";")).toBe(false);
      expect(r3.terminator).toBe(";");
    }
  });

  test("INSERT with semicolon", () => {
    const p = new CommandParser();
    const r = p.feed("INSERT INTO t VALUES (1);");
    expect(r.kind).toBe("sql");
    if (r.kind === "sql") expect(r.text).toBe("INSERT INTO t VALUES (1)");
  });

  test("WITH starts SQL accumulation", () => {
    const p = new CommandParser();
    expect(p.feed("WITH x AS (SELECT 1 FROM dual)").kind).toBe("incomplete");
    const r = p.feed("SELECT * FROM x;");
    expect(r.kind).toBe("sql");
  });

  test("inline trailing -- comment after ; is stripped before terminator check", () => {
    const p = new CommandParser();
    const r = p.feed("SELECT 1 FROM dual; -- trailing");
    expect(r.kind).toBe("sql");
    if (r.kind === "sql") {
      expect(r.text).toBe("SELECT 1 FROM dual");
      expect(r.terminator).toBe(";");
    }
  });

  test("unknown first word with no SQL starter is treated as SQL", () => {
    const p = new CommandParser();
    const r = p.feed("SHOWPARAMETERZZZ x;");
    expect(r.kind).toBe("sql");
  });

  test("after a SQL emit the parser is reset for the next statement", () => {
    const p = new CommandParser();
    expect(p.feed("SELECT 1 FROM dual;").kind).toBe("sql");
    expect(p.feed("").kind).toBe("blank");
  });
});

describe("CommandParser — PL/SQL blocks", () => {
  test("BEGIN ... END; / closes the block", () => {
    const p = new CommandParser();
    expect(p.feed("BEGIN").kind).toBe("incomplete");
    expect(p.feed("  NULL;").kind).toBe("incomplete");
    expect(p.feed("END;").kind).toBe("incomplete");
    const r = p.feed("/");
    expect(r.kind).toBe("plsql");
    if (r.kind === "plsql") {
      expect(r.terminator).toBe("/");
      expect(r.text).toContain("BEGIN");
      expect(r.text).toContain("END;");
      expect(r.text).not.toContain("\n/");
    }
  });

  test("DECLARE opens a block", () => {
    const p = new CommandParser();
    expect(p.feed("DECLARE").kind).toBe("incomplete");
    expect(p.isInBlock()).toBe(true);
    expect(p.feed("  v_x NUMBER := 1;").kind).toBe("incomplete");
    expect(p.feed("BEGIN").kind).toBe("incomplete");
    expect(p.feed("  NULL;").kind).toBe("incomplete");
    expect(p.feed("END;").kind).toBe("incomplete");
    const r = p.feed("  /  ");
    expect(r.kind).toBe("plsql");
  });

  test("blank line inside a block is absorbed", () => {
    const p = new CommandParser();
    expect(p.feed("BEGIN").kind).toBe("incomplete");
    const blankInside = p.feed("");
    expect(blankInside.kind).toBe("incomplete");
    if (blankInside.kind === "incomplete") {
      expect(blankInside.partial).toContain("BEGIN");
    }
    expect(p.feed("END;").kind).toBe("incomplete");
    const r = p.feed("/");
    expect(r.kind).toBe("plsql");
  });

  test("/ alone outside a block is a no-op blank", () => {
    const p = new CommandParser();
    expect(p.feed("/")).toEqual({ kind: "blank" });
  });

  test("isInBlock toggles correctly", () => {
    const p = new CommandParser();
    expect(p.isInBlock()).toBe(false);
    p.feed("BEGIN");
    expect(p.isInBlock()).toBe(true);
    p.feed("END;");
    expect(p.isInBlock()).toBe(true);
    p.feed("/");
    expect(p.isInBlock()).toBe(false);
  });
});

describe("CommandParser — directives: SET / SHOW", () => {
  test("SET PAGESIZE 50", () => {
    const p = new CommandParser();
    const r = p.feed("SET PAGESIZE 50");
    expect(r).toEqual({
      kind: "directive",
      name: "SET",
      args: ["PAGESIZE", "50"],
      raw: "SET PAGESIZE 50",
    });
  });

  test("SET PAGESIZE 50; trailing semicolon stripped", () => {
    const p = new CommandParser();
    const r = p.feed("SET PAGESIZE 50;");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("SET");
      expect(r.args).toEqual(["PAGESIZE", "50"]);
    }
  });

  test("SHOW LINESIZE", () => {
    const p = new CommandParser();
    const r = p.feed("SHOW LINESIZE");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("SHOW");
      expect(r.args).toEqual(["LINESIZE"]);
    }
  });

  test("SHOW ALL", () => {
    const p = new CommandParser();
    const r = p.feed("SHOW ALL");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.args).toEqual(["ALL"]);
    }
  });

  test("set linesize 80 (lowercase) normalizes name uppercase", () => {
    const p = new CommandParser();
    const r = p.feed("set linesize 80");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("SET");
      expect(r.args[0]).toBe("LINESIZE");
      expect(r.args[1]).toBe("80");
    }
  });
});

describe("CommandParser — directives: DEFINE / UNDEFINE", () => {
  test("DEFINE alone", () => {
    const p = new CommandParser();
    const r = p.feed("DEFINE");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("DEFINE");
      expect(r.args).toEqual([]);
    }
  });

  test("DEFINE x", () => {
    const p = new CommandParser();
    const r = p.feed("DEFINE x");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.args).toEqual(["x"]);
  });

  test("DEFINE x = 5", () => {
    const p = new CommandParser();
    const r = p.feed("DEFINE x = 5");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.args).toEqual(["x", "5"]);
  });

  test("UNDEFINE x y", () => {
    const p = new CommandParser();
    const r = p.feed("UNDEFINE x y");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("UNDEFINE");
      expect(r.args).toEqual(["x", "y"]);
    }
  });
});

describe("CommandParser — directives: COL / COLUMN with quoted args", () => {
  test("COL DEPTNO HEADING \"Dept #\"", () => {
    const p = new CommandParser();
    const r = p.feed('COL DEPTNO HEADING "Dept #"');
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("COLUMN");
      expect(r.args).toEqual(["DEPTNO", "HEADING", "Dept #"]);
    }
  });

  test("COLUMN aliases to itself", () => {
    const p = new CommandParser();
    const r = p.feed("COLUMN ENAME FORMAT A20");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("COLUMN");
      expect(r.args).toEqual(["ENAME", "FORMAT", "A20"]);
    }
  });

  test("single-quoted arg preserved as one token", () => {
    const p = new CommandParser();
    const r = p.feed("COL X HEADING 'Hello World'");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.args).toEqual(["X", "HEADING", "Hello World"]);
    }
  });
});

describe("CommandParser — directives: PROMPT", () => {
  test("PROMPT alone returns single empty-string arg", () => {
    const p = new CommandParser();
    const r = p.feed("PROMPT");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("PROMPT");
      expect(r.args).toEqual([""]);
    }
  });

  test("PROMPT preserves multiple internal spaces and trailing space", () => {
    const p = new CommandParser();
    const r = p.feed("PROMPT  Hello   World ");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("PROMPT");
      expect(r.args).toEqual([" Hello   World "]);
    }
  });

  test("PROMPT Simple message", () => {
    const p = new CommandParser();
    const r = p.feed("PROMPT Simple message");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.args).toEqual(["Simple message"]);
    }
  });
});

describe("CommandParser — directives: EXIT / QUIT", () => {
  test("EXIT alone", () => {
    const p = new CommandParser();
    const r = p.feed("EXIT");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("EXIT");
      expect(r.args).toEqual([]);
    }
  });

  test("QUIT aliases to EXIT", () => {
    const p = new CommandParser();
    const r = p.feed("QUIT");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("EXIT");
      expect(r.args).toEqual([]);
    }
  });

  test("EXIT 0", () => {
    const p = new CommandParser();
    const r = p.feed("EXIT 0");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.args).toEqual(["0"]);
    }
  });

  test("EXIT 1", () => {
    const p = new CommandParser();
    const r = p.feed("EXIT 1");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.args).toEqual(["1"]);
  });

  test("EXIT abc returns SP2-0226 error", () => {
    const p = new CommandParser();
    const r = p.feed("EXIT abc");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("SP2-0226");
    }
  });
});

describe("CommandParser — directives: START / @ / @@", () => {
  test("@/tmp/foo.sql", () => {
    const p = new CommandParser();
    const r = p.feed("@/tmp/foo.sql");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("START");
      expect(r.args).toEqual(["/tmp/foo.sql"]);
    }
  });

  test("@@foo.sql", () => {
    const p = new CommandParser();
    const r = p.feed("@@foo.sql");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("START");
      expect(r.args).toEqual(["foo.sql"]);
    }
  });

  test("@ with space and filename", () => {
    const p = new CommandParser();
    const r = p.feed("@ script.sql");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("START");
      expect(r.args).toEqual(["script.sql"]);
    }
  });

  test("START scriptname.sql", () => {
    const p = new CommandParser();
    const r = p.feed("START scriptname.sql");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("START");
      expect(r.args).toEqual(["scriptname.sql"]);
    }
  });

  test("START with positional params", () => {
    const p = new CommandParser();
    const r = p.feed("START foo.sql arg1 arg2");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.args).toEqual(["foo.sql", "arg1", "arg2"]);
    }
  });

  test("START alone returns SP2-0310", () => {
    const p = new CommandParser();
    const r = p.feed("START");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("SP2-0310");
    }
  });

  test("@ alone returns SP2-0310", () => {
    const p = new CommandParser();
    const r = p.feed("@");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("SP2-0310");
    }
  });

  test("@@ alone returns SP2-0310", () => {
    const p = new CommandParser();
    const r = p.feed("@@");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe("SP2-0310");
    }
  });
});

describe("CommandParser — directives: CONNECT / DISCONNECT", () => {
  test("CONNECT scott/tiger@orcl", () => {
    const p = new CommandParser();
    const r = p.feed("CONNECT scott/tiger@orcl");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("CONNECT");
      expect(r.args).toEqual(["scott/tiger@orcl"]);
    }
  });

  test("CONN aliases to CONNECT", () => {
    const p = new CommandParser();
    const r = p.feed("CONN scott");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("CONNECT");
      expect(r.args).toEqual(["scott"]);
    }
  });

  test("DISCONNECT alone", () => {
    const p = new CommandParser();
    const r = p.feed("DISCONNECT");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("DISCONNECT");
      expect(r.args).toEqual([]);
    }
  });

  test("DISC aliases to DISCONNECT", () => {
    const p = new CommandParser();
    const r = p.feed("DISC");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.name).toBe("DISCONNECT");
  });
});

describe("CommandParser — directives: HOST / ! / CLEAR", () => {
  test("! ls -la", () => {
    const p = new CommandParser();
    const r = p.feed("! ls -la");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("HOST");
      expect(r.args).toEqual(["ls -la"]);
    }
  });

  test("HOST echo hello", () => {
    const p = new CommandParser();
    const r = p.feed("HOST echo hello");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("HOST");
      expect(r.args).toEqual(["echo hello"]);
    }
  });

  test("HO ls (alias)", () => {
    const p = new CommandParser();
    const r = p.feed("HO ls");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("HOST");
      expect(r.args).toEqual(["ls"]);
    }
  });

  test("CLEAR SCREEN", () => {
    const p = new CommandParser();
    const r = p.feed("CLEAR SCREEN");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("CLEAR");
      expect(r.args).toEqual(["SCREEN"]);
    }
  });

  test("CL SCR (alias to CLEAR)", () => {
    const p = new CommandParser();
    const r = p.feed("CL SCR");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("CLEAR");
      expect(r.args).toEqual(["SCR"]);
    }
  });
});

describe("CommandParser — directives: SPOOL / EDIT", () => {
  test("SPOOL output.txt", () => {
    const p = new CommandParser();
    const r = p.feed("SPOOL output.txt");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("SPOOL");
      expect(r.args).toEqual(["output.txt"]);
    }
  });

  test("SPOOL OFF", () => {
    const p = new CommandParser();
    const r = p.feed("SPOOL OFF");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.args).toEqual(["OFF"]);
  });

  test("SPOOL alone", () => {
    const p = new CommandParser();
    const r = p.feed("SPOOL");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.args).toEqual([]);
  });

  test("SPOOL with quoted path", () => {
    const p = new CommandParser();
    const r = p.feed('SPOOL "C:\\Program Files\\out.txt"');
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.args).toEqual(["C:\\Program Files\\out.txt"]);
    }
  });

  test("EDIT myfile.sql", () => {
    const p = new CommandParser();
    const r = p.feed("EDIT myfile.sql");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("EDIT");
      expect(r.args).toEqual(["myfile.sql"]);
    }
  });

  test("EDIT alone", () => {
    const p = new CommandParser();
    const r = p.feed("EDIT");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") expect(r.args).toEqual([""]);
  });
});

describe("CommandParser — directives: ACCEPT / WHENEVER", () => {
  test("ACCEPT x PROMPT 'Enter:'", () => {
    const p = new CommandParser();
    const r = p.feed("ACCEPT x PROMPT 'Enter:'");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("ACCEPT");
      expect(r.args).toEqual(["x", "PROMPT", "Enter:"]);
    }
  });

  test("WHENEVER SQLERROR EXIT", () => {
    const p = new CommandParser();
    const r = p.feed("WHENEVER SQLERROR EXIT");
    expect(r.kind).toBe("directive");
    if (r.kind === "directive") {
      expect(r.name).toBe("WHENEVER");
      expect(r.args).toEqual(["SQLERROR", "EXIT"]);
    }
  });
});
