// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

export interface PromptOpts {
  lineNumber: number;
  isContinuation: boolean;
  user?: string | null;
  service?: string | null;
}

export function formatPrompt(opts: PromptOpts): string {
  const line = opts.lineNumber < 1 ? 1 : Math.floor(opts.lineNumber);
  return `${String(line).padStart(3, " ")}  `;
}

export function formatConnectionLabel(
  user: string | null | undefined,
  service: string | null | undefined,
): string {
  if (!user) return "";
  if (!service) return `${user}>`;
  return `${user}@${service}>`;
}
