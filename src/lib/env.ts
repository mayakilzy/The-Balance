// ============================================================
// env.ts — Validated environment access (Zod)
// ------------------------------------------------------------
// Every env var is read through this module. The schema is checked
// once at startup; downstream code can safely use the typed `env`
// export without re-parsing.
// ============================================================
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_NAME: z.string().default("The Balance"),
  APP_VERSION: z.string().default("0.0.1"),

  // Database (PostgreSQL 16 + pgvector)
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  // Auth.js v5
  AUTH_SECRET: z
    .string()
    .min(16, "AUTH_SECRET must be at least 16 chars (use: openssl rand -base64 32)"),
  AUTH_URL: z.string().url().optional(),
  AUTH_TRUST_HOST: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Deployment shape — affects rate-limiting trust policy (00-09).
  // When "true", x-forwarded-for is honored (deploy behind a known
  // reverse proxy). When unset/"false", client-supplied IP headers
  // are NEVER trusted and rate limits fall back to a shared bucket.
  TRUSTED_PROXY: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),

  // LLM Provider Abstraction
  LLM_PROVIDER: z
    .enum(["stub", "zai", "openai", "anthropic"])
    .default("stub"),

  // Observability
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Environment validation failed:\n${issues}\n\nCheck .env against .env.example.`
    );
  }
  return parsed.data;
}

// Lazily evaluated — only parsed on first access, so test setups can
// modify process.env before the first import of `env`.
let _env: Env | null = null;

export function getEnv(): Env {
  if (_env === null) {
    _env = parseEnv();
  }
  return _env;
}

export function resetEnvForTesting(): void {
  _env = null;
}

// Convenience: typed access without importing getEnv everywhere.
export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
