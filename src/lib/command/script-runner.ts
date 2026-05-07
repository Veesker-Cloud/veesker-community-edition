// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { readCommandScript } from "./history";
import { CommandParser } from "./parser";
import type { Parsed } from "./types";

export interface ScriptLoadResult {
	path: string;
	lines: string[];
	raw: string;
}

export interface ScriptParseEvent {
	lineIndex: number;
	rawLine: string;
	parsed: Parsed;
}

export async function loadScript(path: string): Promise<ScriptLoadResult> {
	const raw = await readCommandScript(path);
	const lines = splitLines(raw);
	return { path, lines, raw };
}

export function parseScript(source: string): ScriptParseEvent[] {
	const lines = splitLines(source);
	const events: ScriptParseEvent[] = [];
	const parser = new CommandParser();
	let pendingPartial: string | null = null;
	let pendingLineIndex = 0;
	let pendingRawLine = "";

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const parsed = parser.feed(rawLine);

		if (parsed.kind === "incomplete") {
			pendingPartial = parsed.partial;
			if (rawLine.trim() !== "") {
				pendingLineIndex = i;
				pendingRawLine = rawLine;
			}
			continue;
		}

		pendingPartial = null;

		if (parsed.kind === "blank") continue;

		events.push({ lineIndex: i, rawLine, parsed });
	}

	if (pendingPartial !== null) {
		events.push({
			lineIndex: pendingLineIndex,
			rawLine: pendingRawLine,
			parsed: {
				kind: "error",
				code: "SP2-0734",
				message: "unterminated SQL statement at end of script",
				raw: pendingPartial,
			},
		});
	}

	return events;
}

function splitLines(source: string): string[] {
	if (source === "") return [];
	const parts = source.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}
