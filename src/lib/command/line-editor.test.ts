// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { LineEditor, type LineEditorOutput } from "./line-editor";

function lastRedraw(
	out: LineEditorOutput[],
): { buffer: string; cursor: number } | null {
	for (let i = out.length - 1; i >= 0; i--) {
		const ev = out[i];
		if (ev.kind === "redraw") return { buffer: ev.buffer, cursor: ev.cursor };
	}
	return null;
}

function submits(out: LineEditorOutput[]): string[] {
	return out
		.filter((e) => e.kind === "submit")
		.map((e) => (e as { kind: "submit"; line: string }).line);
}

describe("LineEditor — character insertion", () => {
	test("inserts a single char into empty buffer and emits redraw", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "char", ch: "a" });
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({ kind: "redraw", buffer: "a", cursor: 1 });
		expect(ed.getBuffer()).toBe("a");
		expect(ed.getCursor()).toBe(1);
	});

	test("appends successive chars and advances cursor", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "b" });
		const out = ed.handle({ kind: "char", ch: "c" });
		expect(ed.getBuffer()).toBe("abc");
		expect(ed.getCursor()).toBe(3);
		expect(lastRedraw(out)).toEqual({ buffer: "abc", cursor: 3 });
	});

	test("inserts in middle of buffer when cursor is moved", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "c" });
		ed.handle({ kind: "home" });
		ed.handle({ kind: "right" });
		const out = ed.handle({ kind: "char", ch: "b" });
		expect(ed.getBuffer()).toBe("abc");
		expect(ed.getCursor()).toBe(2);
		expect(lastRedraw(out)).toEqual({ buffer: "abc", cursor: 2 });
	});

	test("emoji insertion advances cursor by surrogate-pair length", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "char", ch: "😀" });
		expect(ed.getBuffer()).toBe("😀");
		expect(ed.getCursor()).toBe(2);
		expect(Array.from(ed.getBuffer()).length).toBe(1);
		expect(lastRedraw(out)).toEqual({ buffer: "😀", cursor: 2 });
	});
});

describe("LineEditor — backspace and delete", () => {
	test("backspace at cursor=0 is a no-op (no event)", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "backspace" });
		expect(out).toEqual([]);
		expect(ed.getBuffer()).toBe("");
		expect(ed.getCursor()).toBe(0);
	});

	test("backspace deletes the char before the cursor", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "b" });
		const out = ed.handle({ kind: "backspace" });
		expect(ed.getBuffer()).toBe("a");
		expect(ed.getCursor()).toBe(1);
		expect(out).toEqual([{ kind: "redraw", buffer: "a", cursor: 1 }]);
	});

	test("forward-delete at end of buffer is a no-op", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		const out = ed.handle({ kind: "delete" });
		expect(out).toEqual([]);
		expect(ed.getBuffer()).toBe("a");
		expect(ed.getCursor()).toBe(1);
	});

	test("forward-delete removes char at cursor without moving it", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "b" });
		ed.handle({ kind: "home" });
		const out = ed.handle({ kind: "delete" });
		expect(ed.getBuffer()).toBe("b");
		expect(ed.getCursor()).toBe(0);
		expect(out).toEqual([{ kind: "redraw", buffer: "b", cursor: 0 }]);
	});
});

describe("LineEditor — cursor movement", () => {
	test("left at cursor=0 is a no-op", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "left" });
		expect(out).toEqual([]);
		expect(ed.getCursor()).toBe(0);
	});

	test("left decrements cursor and emits redraw", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		const out = ed.handle({ kind: "left" });
		expect(ed.getCursor()).toBe(0);
		expect(out).toEqual([{ kind: "redraw", buffer: "a", cursor: 0 }]);
	});

	test("right at end of buffer is a no-op", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		const out = ed.handle({ kind: "right" });
		expect(out).toEqual([]);
	});

	test("right increments cursor toward end", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "home" });
		const out = ed.handle({ kind: "right" });
		expect(ed.getCursor()).toBe(1);
		expect(out).toEqual([{ kind: "redraw", buffer: "a", cursor: 1 }]);
	});

	test("home moves cursor to start", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "b" });
		const out = ed.handle({ kind: "home" });
		expect(ed.getCursor()).toBe(0);
		expect(out).toEqual([{ kind: "redraw", buffer: "ab", cursor: 0 }]);
	});

	test("home at cursor=0 is a no-op", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "home" });
		expect(out).toEqual([]);
	});

	test("end moves cursor to buffer end", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "b" });
		ed.handle({ kind: "home" });
		const out = ed.handle({ kind: "end" });
		expect(ed.getCursor()).toBe(2);
		expect(out).toEqual([{ kind: "redraw", buffer: "ab", cursor: 2 }]);
	});

	test("end at end-of-buffer is a no-op", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		const out = ed.handle({ kind: "end" });
		expect(out).toEqual([]);
	});
});

describe("LineEditor — history navigation", () => {
	test("up with empty history is a no-op", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "up" });
		expect(out).toEqual([]);
	});

	test("up recalls the latest history entry", () => {
		const ed = new LineEditor({ initialHistory: ["SELECT 1", "SELECT 2"] });
		const out = ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("SELECT 2");
		expect(ed.getCursor()).toBe("SELECT 2".length);
		expect(out).toEqual([{ kind: "redraw", buffer: "SELECT 2", cursor: 8 }]);
	});

	test("up→up walks backward through history", () => {
		const ed = new LineEditor({ initialHistory: ["SELECT 1", "SELECT 2"] });
		ed.handle({ kind: "up" });
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("SELECT 1");
	});

	test("up clamps at oldest entry", () => {
		const ed = new LineEditor({ initialHistory: ["A", "B"] });
		ed.handle({ kind: "up" });
		ed.handle({ kind: "up" });
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
	});

	test("down with no active history navigation is a no-op", () => {
		const ed = new LineEditor({ initialHistory: ["A"] });
		const out = ed.handle({ kind: "down" });
		expect(out).toEqual([]);
	});

	test("up then down walks forward through history", () => {
		const ed = new LineEditor({ initialHistory: ["A", "B"] });
		ed.handle({ kind: "up" });
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
		ed.handle({ kind: "down" });
		expect(ed.getBuffer()).toBe("B");
	});

	test("down past last entry restores the saved draft", () => {
		const ed = new LineEditor({ initialHistory: ["OLD"] });
		ed.handle({ kind: "char", ch: "n" });
		ed.handle({ kind: "char", ch: "e" });
		ed.handle({ kind: "char", ch: "w" });
		expect(ed.getBuffer()).toBe("new");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("OLD");
		const out = ed.handle({ kind: "down" });
		expect(ed.getBuffer()).toBe("new");
		expect(ed.getCursor()).toBe(3);
		expect(lastRedraw(out)).toEqual({ buffer: "new", cursor: 3 });
	});
});

describe("LineEditor — submit", () => {
	test("submit emits the current line and resets buffer", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "h" });
		ed.handle({ kind: "char", ch: "i" });
		const out = ed.handle({ kind: "submit" });
		expect(submits(out)).toEqual(["hi"]);
		expect(ed.getBuffer()).toBe("");
		expect(ed.getCursor()).toBe(0);
	});

	test("submit emits empty line when buffer is empty", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "submit" });
		expect(submits(out)).toEqual([""]);
	});

	test("submit clears history navigation state", () => {
		const ed = new LineEditor({ initialHistory: ["A"] });
		ed.handle({ kind: "up" });
		ed.handle({ kind: "submit" });
		const out = ed.handle({ kind: "down" });
		expect(out).toEqual([]);
	});
});

describe("LineEditor — pushHistory", () => {
	test("appends a new entry", () => {
		const ed = new LineEditor();
		ed.pushHistory("SELECT 1");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("SELECT 1");
	});

	test("ignores empty entries", () => {
		const ed = new LineEditor();
		ed.pushHistory("");
		const out = ed.handle({ kind: "up" });
		expect(out).toEqual([]);
	});

	test("ignores all-whitespace entries", () => {
		const ed = new LineEditor();
		ed.pushHistory("   \t  ");
		const out = ed.handle({ kind: "up" });
		expect(out).toEqual([]);
	});

	test("de-duplicates adjacent equal entries", () => {
		const ed = new LineEditor();
		ed.pushHistory("A");
		ed.pushHistory("A");
		ed.pushHistory("B");
		ed.pushHistory("B");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("B");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
	});

	test("enforces historyLimit by evicting oldest", () => {
		const ed = new LineEditor({ historyLimit: 2 });
		ed.pushHistory("A");
		ed.pushHistory("B");
		ed.pushHistory("C");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("C");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("B");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("B");
	});
});

describe("LineEditor — setHistory", () => {
	test("replaces entire history", () => {
		const ed = new LineEditor({ initialHistory: ["X"] });
		ed.setHistory(["A", "B"]);
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("B");
	});

	test("filters out empty entries", () => {
		const ed = new LineEditor();
		ed.setHistory(["A", "", "  ", "B"]);
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("B");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
	});

	test("resets navigation state after replacing", () => {
		const ed = new LineEditor({ initialHistory: ["X"] });
		ed.handle({ kind: "up" });
		ed.setHistory(["Y"]);
		const out = ed.handle({ kind: "down" });
		expect(out).toEqual([]);
	});
});

describe("LineEditor — paste", () => {
	test("single-line paste inserts and advances cursor by paste length", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "paste", text: "hello" });
		expect(ed.getBuffer()).toBe("hello");
		expect(ed.getCursor()).toBe(5);
		expect(out).toEqual([{ kind: "redraw", buffer: "hello", cursor: 5 }]);
	});

	test("single-line paste inserts at cursor position", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "x" });
		ed.handle({ kind: "char", ch: "y" });
		ed.handle({ kind: "home" });
		ed.handle({ kind: "right" });
		const out = ed.handle({ kind: "paste", text: "AB" });
		expect(ed.getBuffer()).toBe("xABy");
		expect(ed.getCursor()).toBe(3);
		expect(lastRedraw(out)).toEqual({ buffer: "xABy", cursor: 3 });
	});

	test("multi-line paste with 3 lines emits 3 submits + 1 final redraw", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "paste", text: "a\nb\nc" });
		const subs = submits(out);
		expect(subs).toEqual(["a", "b"]);
		expect(out.filter((e) => e.kind === "redraw").length).toBe(1);
		expect(lastRedraw(out)).toEqual({ buffer: "c", cursor: 1 });
		expect(ed.getBuffer()).toBe("c");
		expect(ed.getCursor()).toBe(1);
	});

	test("multi-line paste keeps existing cursor-prefix on first submitted line", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "X" });
		const out = ed.handle({ kind: "paste", text: "a\nb" });
		expect(submits(out)).toEqual(["Xa"]);
		expect(ed.getBuffer()).toBe("b");
		expect(ed.getCursor()).toBe(1);
	});

	test("paste ending in newline submits everything and leaves empty buffer", () => {
		const ed = new LineEditor();
		const out = ed.handle({ kind: "paste", text: "a\nb\n" });
		expect(submits(out)).toEqual(["a", "b"]);
		expect(ed.getBuffer()).toBe("");
		expect(ed.getCursor()).toBe(0);
	});
});

describe("LineEditor — clear-screen and interrupt", () => {
	test("clear-screen emits clear-screen + redraw without modifying buffer", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		ed.handle({ kind: "char", ch: "b" });
		const out = ed.handle({ kind: "clear-screen" });
		expect(out).toEqual([
			{ kind: "clear-screen" },
			{ kind: "redraw", buffer: "ab", cursor: 2 },
		]);
		expect(ed.getBuffer()).toBe("ab");
		expect(ed.getCursor()).toBe(2);
	});

	test("interrupt clears buffer and emits interrupt + redraw", () => {
		const ed = new LineEditor();
		ed.handle({ kind: "char", ch: "a" });
		const out = ed.handle({ kind: "interrupt" });
		expect(out).toEqual([
			{ kind: "interrupt" },
			{ kind: "redraw", buffer: "", cursor: 0 },
		]);
		expect(ed.getBuffer()).toBe("");
		expect(ed.getCursor()).toBe(0);
	});

	test("interrupt resets history navigation state", () => {
		const ed = new LineEditor({ initialHistory: ["A"] });
		ed.handle({ kind: "up" });
		ed.handle({ kind: "interrupt" });
		const out = ed.handle({ kind: "down" });
		expect(out).toEqual([]);
	});
});

describe("LineEditor — reset", () => {
	test("clears buffer but preserves history", () => {
		const ed = new LineEditor({ initialHistory: ["A"] });
		ed.handle({ kind: "char", ch: "x" });
		ed.reset();
		expect(ed.getBuffer()).toBe("");
		expect(ed.getCursor()).toBe(0);
		ed.handle({ kind: "up" });
		expect(ed.getBuffer()).toBe("A");
	});
});
