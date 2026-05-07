// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { describe, expect, test } from "vitest";
import { computePromptLineNumber } from "./state.svelte";

describe("computePromptLineNumber", () => {
	test("empty buffer returns 1 (first prompt)", () => {
		expect(computePromptLineNumber("")).toBe(1);
	});

	test("one line of accumulated input returns 2 (next line is line 2)", () => {
		expect(computePromptLineNumber("SELECT *")).toBe(2);
	});

	test("two lines of accumulated input returns 3", () => {
		expect(computePromptLineNumber("SELECT *\nFROM dual")).toBe(3);
	});

	test("three lines returns 4", () => {
		expect(computePromptLineNumber("BEGIN\n  null;\nEND;")).toBe(4);
	});

	test("trailing newline counts toward the next line number", () => {
		expect(computePromptLineNumber("SELECT *\n")).toBe(3);
	});
});
