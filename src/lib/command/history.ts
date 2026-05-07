// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { invoke } from "@tauri-apps/api/core";
import type { CommandHistoryEntry } from "./types";

export async function loadCommandHistory(
	connectionId: string,
	limit = 1000,
): Promise<CommandHistoryEntry[]> {
	return invoke<CommandHistoryEntry[]>("command_history_load", {
		connectionId,
		limit,
	});
}

export async function appendCommandHistory(
	connectionId: string,
	command: string,
	origin: "user_typed" | "script" | "paste" = "user_typed",
	status: "ok" | "error" | "cancelled" = "ok",
	durationMs: number | null = null,
): Promise<number> {
	return invoke<number>("command_history_append", {
		connectionId,
		command,
		origin,
		status,
		durationMs,
	});
}

export async function readCommandScript(path: string): Promise<string> {
	return invoke<string>("command_script_read", { path });
}
