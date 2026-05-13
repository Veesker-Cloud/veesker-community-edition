// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { ensureSandboxKeypair } from "$lib/sandbox";

class SandboxKeypairStore {
  isRegistered = $state(false);
  pubkey_b64 = $state<string | null>(null);
  registered_at = $state<string | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  reset() {
    this.isRegistered = false;
    this.pubkey_b64 = null;
    this.registered_at = null;
    this.loading = false;
    this.error = null;
  }

  async ensure() {
    this.loading = true;
    this.error = null;
    try {
      const result = await ensureSandboxKeypair();
      this.pubkey_b64 = result.pubkey_b64;
      this.registered_at = result.registered_at;
      this.isRegistered = true;
    } catch (e) {
      this.error = (e as Error).message ?? String(e);
      this.isRegistered = false;
    } finally {
      this.loading = false;
    }
  }
}

export const sandboxKeypair = new SandboxKeypairStore();
