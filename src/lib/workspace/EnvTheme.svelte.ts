export type EnvThemeConfig = {
  env: "dev" | "staging" | "prod" | "custom";
  accentColor: string;
  label: string;
};

const DEFAULTS: Record<string, EnvThemeConfig> = {
  prod:    { env: "prod",    accentColor: "#b33e1f", label: "PRODUCTION" },
  staging: { env: "staging", accentColor: "#d97706", label: "STAGING" },
  dev:     { env: "dev",     accentColor: "#2563eb", label: "DEV" },
};

class EnvThemeStore {
  current = $state<EnvThemeConfig | null>(null);

  setFromEnv(env: string | undefined) {
    this.current = env ? (DEFAULTS[env] ?? null) : null;
  }

  get cssVar() {
    return this.current ? `--env-accent: ${this.current.accentColor};` : "";
  }
}

export const envTheme = new EnvThemeStore();
