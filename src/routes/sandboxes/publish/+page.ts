// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { ensureSandboxKeypair } from "$lib/sandbox";

export const ssr = false;

export async function load() {
  try {
    await ensureSandboxKeypair();
  } catch (err) {
    return { keypairError: err instanceof Error ? err.message : String(err) };
  }
  return { keypairError: null };
}
