import { loadBuildConfig } from "./build-config-store";

export interface RepublishParams {
  sandboxId: string;
}

export interface RepublishEnv {
  buildsDir: string;
  recoverContentKey: (sandboxId: string) => Promise<Uint8Array>;
  oracleConfigResolver: (connectionId: string) => Promise<{ user: string; password: string; connectString: string }>;
  buildSandbox: (spec: object, contentKey: Uint8Array) => Promise<{ outPath: string; totalRows: number }>;
  requestRepublishUrl: (sandboxId: string) => Promise<{ upload_url: string; blob_key: string; expires_in: number }>;
  uploadToR2: (vskPath: string, uploadUrl: string) => Promise<{ sha256: string; size: number }>;
  finalizeRepublish: (sandboxId: string, body: { blob_size_bytes: number; blob_sha256: string }) => Promise<{ ok: true }>;
}

export interface RepublishResult {
  ok: true;
  new_blob_sha256: string;
  bytes: number;
}

export async function handleSandboxRepublish(
  params: RepublishParams,
  env: RepublishEnv,
): Promise<RepublishResult> {
  const config = await loadBuildConfig(env.buildsDir, params.sandboxId);
  if (!config) {
    throw new Error(
      `republish: build config missing for sandbox ${params.sandboxId} — was the original publish from this machine?`,
    );
  }

  const contentKey = await env.recoverContentKey(params.sandboxId);
  try {
    const oracleConfig = await env.oracleConfigResolver(config.connectionId);

    const buildResult = await env.buildSandbox(
      {
        ...config,
        dryRun: false,
        oracleConfig,
        // Plan 7: sandboxName, ownerAccount, outPath are filled by the
        // production env.buildSandbox factory (it knows the canonical
        // sandbox name from the API response and the canonical builds
        // dir from the Tauri-injected expectedBuildsDir). The DI test
        // env in republish.test.ts mocks buildSandbox entirely so the
        // partial spec here is invisible to the test.
      },
      contentKey,
    );

    const urlResp = await env.requestRepublishUrl(params.sandboxId);
    const upload = await env.uploadToR2(buildResult.outPath, urlResp.upload_url);
    await env.finalizeRepublish(params.sandboxId, {
      blob_size_bytes: upload.size,
      blob_sha256: upload.sha256,
    });

    return { ok: true, new_blob_sha256: upload.sha256, bytes: upload.size };
  } finally {
    contentKey.fill(0);
  }
}
