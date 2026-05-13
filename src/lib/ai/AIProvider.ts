// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/Veesker-Cloud/veesker

import type { AiContext, AiMessage, AiChatResult } from "$lib/workspace";

export type ChatParams = {
  apiKey: string;
  messages: AiMessage[];
  context: AiContext;
  // PROD-001 (audit 2026-04-30): set true after the user accepted the per-
  // session unlock modal for prod-tagged connections. Sidecar refuses if
  // env='prod' and this is false.
  acknowledgeProdAi?: boolean;
};

export type ChatResult = AiChatResult;

export type ProviderError = {
  code?: string;
  message: string;
};

export interface AIProvider {
  chat(params: ChatParams): Promise<{ ok: true; data: ChatResult } | { ok: false; error: ProviderError }>;
}
