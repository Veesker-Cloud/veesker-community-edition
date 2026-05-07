// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

export type LineEditorEvent =
	| { kind: "char"; ch: string }
	| { kind: "paste"; text: string }
	| { kind: "backspace" }
	| { kind: "delete" }
	| { kind: "left" }
	| { kind: "right" }
	| { kind: "home" }
	| { kind: "end" }
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "clear-screen" }
	| { kind: "interrupt" }
	| { kind: "submit" };

export type LineEditorOutput =
	| { kind: "redraw"; buffer: string; cursor: number }
	| { kind: "submit"; line: string }
	| { kind: "interrupt" }
	| { kind: "clear-screen" };

export interface LineEditorOptions {
	historyLimit?: number;
	initialHistory?: string[];
}

const DEFAULT_HISTORY_LIMIT = 1000;

interface DraftSlot {
	buffer: string;
	cursor: number;
}

export class LineEditor {
	// Cursor positions are JS UTF-16 code-unit offsets — surrogate-pair emoji
	// therefore advance the cursor by 2; callers compare logical char counts
	// via Array.from(buffer).length when they care about grapheme counts.
	private buffer = "";
	private cursor = 0;
	private history: string[];
	private historyLimit: number;
	private historyIndex: number | null = null;
	private draft: DraftSlot | null = null;

	constructor(opts?: LineEditorOptions) {
		this.historyLimit = opts?.historyLimit ?? DEFAULT_HISTORY_LIMIT;
		this.history = (opts?.initialHistory ?? []).filter((e) => e.trim() !== "");
	}

	getBuffer(): string {
		return this.buffer;
	}

	getCursor(): number {
		return this.cursor;
	}

	reset(): void {
		this.buffer = "";
		this.cursor = 0;
		this.historyIndex = null;
		this.draft = null;
	}

	setHistory(entries: string[]): void {
		this.history = entries.filter((e) => e.trim() !== "");
		this.historyIndex = null;
		this.draft = null;
	}

	pushHistory(entry: string): void {
		if (entry.trim() === "") return;
		if (
			this.history.length > 0 &&
			this.history[this.history.length - 1] === entry
		)
			return;
		this.history.push(entry);
		while (this.history.length > this.historyLimit) {
			this.history.shift();
		}
	}

	handle(ev: LineEditorEvent): LineEditorOutput[] {
		switch (ev.kind) {
			case "char":
				return this.handleChar(ev.ch);
			case "paste":
				return this.handlePaste(ev.text);
			case "backspace":
				return this.handleBackspace();
			case "delete":
				return this.handleDelete();
			case "left":
				return this.handleLeft();
			case "right":
				return this.handleRight();
			case "home":
				return this.handleHome();
			case "end":
				return this.handleEnd();
			case "up":
				return this.handleUp();
			case "down":
				return this.handleDown();
			case "clear-screen":
				return [{ kind: "clear-screen" }, this.redraw()];
			case "interrupt":
				return this.handleInterrupt();
			case "submit":
				return this.handleSubmit();
		}
	}

	private redraw(): LineEditorOutput {
		return { kind: "redraw", buffer: this.buffer, cursor: this.cursor };
	}

	private handleChar(ch: string): LineEditorOutput[] {
		this.buffer =
			this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
		this.cursor += ch.length;
		return [this.redraw()];
	}

	private handlePaste(text: string): LineEditorOutput[] {
		if (!text.includes("\n")) {
			this.buffer =
				this.buffer.slice(0, this.cursor) +
				text +
				this.buffer.slice(this.cursor);
			this.cursor += text.length;
			return [this.redraw()];
		}
		const segments = text.split("\n");
		const out: LineEditorOutput[] = [];
		const firstLine =
			this.buffer.slice(0, this.cursor) +
			segments[0] +
			this.buffer.slice(this.cursor);
		out.push({ kind: "submit", line: firstLine });
		for (let i = 1; i < segments.length - 1; i++) {
			out.push({ kind: "submit", line: segments[i] });
		}
		const tail = segments[segments.length - 1];
		this.buffer = tail;
		this.cursor = tail.length;
		this.historyIndex = null;
		this.draft = null;
		out.push(this.redraw());
		return out;
	}

	private handleBackspace(): LineEditorOutput[] {
		if (this.cursor === 0) return [];
		this.buffer =
			this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
		this.cursor -= 1;
		return [this.redraw()];
	}

	private handleDelete(): LineEditorOutput[] {
		if (this.cursor >= this.buffer.length) return [];
		this.buffer =
			this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
		return [this.redraw()];
	}

	private handleLeft(): LineEditorOutput[] {
		if (this.cursor === 0) return [];
		this.cursor -= 1;
		return [this.redraw()];
	}

	private handleRight(): LineEditorOutput[] {
		if (this.cursor >= this.buffer.length) return [];
		this.cursor += 1;
		return [this.redraw()];
	}

	private handleHome(): LineEditorOutput[] {
		if (this.cursor === 0) return [];
		this.cursor = 0;
		return [this.redraw()];
	}

	private handleEnd(): LineEditorOutput[] {
		if (this.cursor === this.buffer.length) return [];
		this.cursor = this.buffer.length;
		return [this.redraw()];
	}

	private handleUp(): LineEditorOutput[] {
		if (this.history.length === 0) return [];
		if (this.historyIndex === null) {
			this.draft = { buffer: this.buffer, cursor: this.cursor };
			this.historyIndex = this.history.length - 1;
		} else {
			this.historyIndex = Math.max(0, this.historyIndex - 1);
		}
		this.buffer = this.history[this.historyIndex];
		this.cursor = this.buffer.length;
		return [this.redraw()];
	}

	private handleDown(): LineEditorOutput[] {
		if (this.historyIndex === null) return [];
		this.historyIndex += 1;
		if (this.historyIndex > this.history.length - 1) {
			const draft = this.draft ?? { buffer: "", cursor: 0 };
			this.buffer = draft.buffer;
			this.cursor = draft.cursor;
			this.historyIndex = null;
			this.draft = null;
			return [this.redraw()];
		}
		this.buffer = this.history[this.historyIndex];
		this.cursor = this.buffer.length;
		return [this.redraw()];
	}

	private handleInterrupt(): LineEditorOutput[] {
		this.buffer = "";
		this.cursor = 0;
		this.historyIndex = null;
		this.draft = null;
		return [{ kind: "interrupt" }, this.redraw()];
	}

	private handleSubmit(): LineEditorOutput[] {
		const line = this.buffer;
		this.buffer = "";
		this.cursor = 0;
		this.historyIndex = null;
		this.draft = null;
		return [{ kind: "submit", line }];
	}
}
