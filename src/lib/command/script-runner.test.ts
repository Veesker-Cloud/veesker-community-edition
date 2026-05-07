// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { parseScript } from "./script-runner";

describe("parseScript — empty and trivial inputs", () => {
	test("empty source yields no events", () => {
		expect(parseScript("")).toEqual([]);
	});

	test("only whitespace yields no events", () => {
		expect(parseScript("   \n\n\t\n")).toEqual([]);
	});
});

describe("parseScript — single-statement scripts", () => {
	test("single SQL statement", () => {
		const events = parseScript("SELECT * FROM dual;\n");
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("sql");
		if (events[0].parsed.kind === "sql") {
			expect(events[0].parsed.text).toBe("SELECT * FROM dual");
			expect(events[0].parsed.terminator).toBe(";");
		}
		expect(events[0].rawLine).toBe("SELECT * FROM dual;");
		expect(events[0].lineIndex).toBe(0);
	});

	test("single comment-only line", () => {
		const events = parseScript("-- a comment\n");
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("comment");
	});

	test("single directive line", () => {
		const events = parseScript("SET PAGESIZE 50\n");
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("directive");
		if (events[0].parsed.kind === "directive") {
			expect(events[0].parsed.name).toBe("SET");
			expect(events[0].parsed.args).toEqual(["PAGESIZE", "50"]);
		}
	});
});

describe("parseScript — multi-line accumulation", () => {
	test("multi-line SQL across 3 lines emits one sql event", () => {
		const source = "SELECT *\nFROM employees\nWHERE deptno = 10;\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("sql");
		if (events[0].parsed.kind === "sql") {
			expect(events[0].parsed.text).toContain("SELECT *");
			expect(events[0].parsed.text).toContain("FROM employees");
			expect(events[0].parsed.text).toContain("WHERE deptno = 10");
		}
		expect(events[0].lineIndex).toBe(2);
	});

	test("PL/SQL block terminated by / on its own line", () => {
		const source = "BEGIN dbms_output.put_line('x'); END;\n/\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("plsql");
		if (events[0].parsed.kind === "plsql") {
			expect(events[0].parsed.text).toContain("BEGIN");
			expect(events[0].parsed.text).toContain("END;");
			expect(events[0].parsed.terminator).toBe("/");
		}
		expect(events[0].lineIndex).toBe(1);
	});
});

describe("parseScript — multiple statements", () => {
	test("two SQL statements separated by blank line", () => {
		const source = "SELECT 1 FROM dual;\n\nSELECT 2 FROM dual;\n";
		const events = parseScript(source);
		expect(events.length).toBe(2);
		expect(events[0].parsed.kind).toBe("sql");
		expect(events[1].parsed.kind).toBe("sql");
		if (events[0].parsed.kind === "sql")
			expect(events[0].parsed.text).toBe("SELECT 1 FROM dual");
		if (events[1].parsed.kind === "sql")
			expect(events[1].parsed.text).toBe("SELECT 2 FROM dual");
	});

	test("mixed sql + plsql + sql", () => {
		const source =
			"SELECT 1 FROM dual;\nBEGIN null; END;\n/\nSELECT 2 FROM dual;\n";
		const events = parseScript(source);
		expect(events.length).toBe(3);
		expect(events[0].parsed.kind).toBe("sql");
		expect(events[1].parsed.kind).toBe("plsql");
		expect(events[2].parsed.kind).toBe("sql");
	});
});

describe("parseScript — line endings and whitespace", () => {
	test("CRLF line endings handled by stripping \\r", () => {
		const source = "SELECT 1 FROM dual;\r\nSELECT 2 FROM dual;\r\n";
		const events = parseScript(source);
		expect(events.length).toBe(2);
		expect(events[0].parsed.kind).toBe("sql");
		expect(events[1].parsed.kind).toBe("sql");
		if (events[0].parsed.kind === "sql")
			expect(events[0].parsed.text).toBe("SELECT 1 FROM dual");
		if (events[1].parsed.kind === "sql")
			expect(events[1].parsed.text).toBe("SELECT 2 FROM dual");
		expect(events[0].rawLine).toBe("SELECT 1 FROM dual;");
		expect(events[1].rawLine).toBe("SELECT 2 FROM dual;");
	});

	test("trailing blank lines after a complete statement emit nothing extra", () => {
		const source = "SELECT 1 FROM dual;\n\n\n\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("sql");
	});
});

describe("parseScript — unterminated statements at EOF", () => {
	test("unterminated SQL at EOF yields SP2-0734 error", () => {
		const source = "SELECT * FROM dual\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("error");
		if (events[0].parsed.kind === "error") {
			expect(events[0].parsed.code).toBe("SP2-0734");
			expect(events[0].parsed.message).toContain("unterminated");
			expect(events[0].parsed.raw).toContain("SELECT * FROM dual");
		}
	});

	test("unterminated PL/SQL block at EOF yields SP2-0734 error", () => {
		const source = "BEGIN null;\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].parsed.kind).toBe("error");
		if (events[0].parsed.kind === "error") {
			expect(events[0].parsed.code).toBe("SP2-0734");
			expect(events[0].parsed.raw).toContain("BEGIN");
		}
	});
});

describe("parseScript — error events do not stop processing", () => {
	test("error mid-script then valid statements continue", () => {
		const source = "EXIT abc\nSELECT 1 FROM dual;\n";
		const events = parseScript(source);
		expect(events.length).toBe(2);
		expect(events[0].parsed.kind).toBe("error");
		if (events[0].parsed.kind === "error") {
			expect(events[0].parsed.code).toBe("SP2-0226");
		}
		expect(events[1].parsed.kind).toBe("sql");
	});
});

describe("parseScript — lineIndex points to terminator line", () => {
	test("multi-line SQL lineIndex matches the line where ; appears", () => {
		const source = "SELECT *\nFROM dual;\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].lineIndex).toBe(1);
		expect(events[0].rawLine).toBe("FROM dual;");
	});

	test("PL/SQL lineIndex matches the / line", () => {
		const source = "BEGIN\nnull;\nEND;\n/\n";
		const events = parseScript(source);
		expect(events.length).toBe(1);
		expect(events[0].lineIndex).toBe(3);
		expect(events[0].rawLine).toBe("/");
	});
});
