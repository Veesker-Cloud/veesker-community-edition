import { invoke } from "@tauri-apps/api/core";
import { applyFeatureFlags, resetFeatures } from "./features";
import { CloudAuditService } from "./CloudAuditService";
import { getCurrentWindow } from "@tauri-apps/api/window";

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded.exp === "number" ? decoded.exp : null;
  } catch {
    return null;
  }
}

export async function initAuth(): Promise<void> {
  const token = await invoke<string | null>("auth_token_get");
  if (!token) return;

  const exp = decodeJwtExp(token);
  if (!exp || Date.now() / 1000 > exp) {
    await invoke("auth_token_clear");
    resetFeatures();
    return;
  }

  // LOW-004 (audit 2026-04-30): cached features in localStorage are advisory
  // only. The authoritative gate is server-side: every API call validated
  // against the user's JWT claims + org tier. A user tampering with this
  // localStorage entry can flip UI affordances client-side, but the server
  // refuses any actual feature usage they're not entitled to. Documented as
  // accepted residual risk in REMEDIATION_NOTES.md.
  const stored = localStorage.getItem("veesker:features");
  if (stored) {
    try {
      const flags = JSON.parse(stored);
      applyFeatureFlags(flags);
      if (flags.cloudAudit) CloudAuditService.start();
    } catch {
      // malformed — ignore, background refresh will fix it
    }
  }

  // Background refresh via Tauri command (no CORS, works in dev + prod)
  void invoke<{ features?: Record<string, boolean> }>("cloud_api_get", {
    path: "/v1/auth/me",
    params: {},
  }).then((data) => {
    if (data.features) {
      applyFeatureFlags(data.features);
      localStorage.setItem("veesker:features", JSON.stringify(data.features));
      if (data.features.cloudAudit) CloudAuditService.start();
    }
  }).catch(async (e: unknown) => {
    if (String(e).includes("server_error_401") || String(e).includes("not_authenticated")) {
      await invoke("auth_token_clear");
      resetFeatures();
      localStorage.removeItem("veesker:features");
    }
    // Other errors (network, etc.) — already applied from localStorage above
  });
}

export async function logout(): Promise<void> {
  CloudAuditService.stop();
  await invoke("auth_token_clear");
  localStorage.removeItem("veesker:features");
  resetFeatures();
  void getCurrentWindow().setTitle("Veesker");
}
