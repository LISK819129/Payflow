import { z } from "zod";

/**
 * Server environment. Read once, validated with zod.
 *
 * Integrations are optional at boot: a missing PayPal or AI key must not crash
 * the app, it must make the app say "setup required" for exactly that feature.
 * Core settings (database, session secret) are required.
 */

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

const boolFlag = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),

  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  PAYPAL_ALLOW_SIMULATOR_EVENTS: boolFlag,

  AI_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
  OPENAI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL_COMPILE: optionalString,
  AI_MODEL_FAST: optionalString,
  /** Ceiling on a compile call's output (reasoning + answer). Raising it raises the worst-case cost. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(2000).max(64000).default(16000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    const problems = productionProblems(parsed.data, process.env);
    if (problems.length) throw new Error(["Unsafe production configuration:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  if (parsed.data.PAYPAL_ENV === "live") {
    // PayFlow is a Sandbox product for the hackathon. Refuse to boot against
    // real money rather than trusting a config flag downstream.
    throw new Error("PAYPAL_ENV=live is not supported. PayFlow runs against PayPal Sandbox only.");
  }
  cached = parsed.data;
  return cached;
}

/** The local-development database password published in .env.example. A hosted database must never use it. */
function localDevPassword(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const text = (require("node:fs") as typeof import("node:fs")).readFileSync(".env.example", "utf8");
    const m = /^DATABASE_URL=postgres:\/\/[^:]+:([^@]+)@/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * What a hosted deployment must not run with. Checked at boot in production
 * (not during `next build`). PAYFLOW_ALLOW_LOCAL_DB=true permits a local
 * production rehearsal against the embedded database — never set it on a host.
 */
export function productionProblems(e: Env, raw: Record<string, string | undefined>, devPassword: string | null = localDevPassword()): string[] {
  const out: string[] = [];
  const local = raw.PAYFLOW_ALLOW_LOCAL_DB === "true";
  let db: URL | null = null;
  try {
    db = new URL(e.DATABASE_URL);
  } catch {
    out.push("DATABASE_URL is not a valid URL");
  }
  if (db && !local) {
    if (["127.0.0.1", "localhost", "::1"].includes(db.hostname)) out.push("DATABASE_URL points at a local database");
    if (devPassword && decodeURIComponent(db.password) === devPassword) out.push("DATABASE_URL reuses the local-development password — create a new credential for the hosted database");
    if (decodeURIComponent(db.password).length < 16) out.push("the database password is shorter than 16 characters");
  }
  if (!local && !e.APP_URL.startsWith("https://")) out.push("APP_URL must be the public https:// URL");
  if (/^(.)\1+$/.test(e.SESSION_SECRET) || /change|example|secret|placeholder/i.test(e.SESSION_SECRET)) out.push("SESSION_SECRET looks like a placeholder — generate 32+ random characters");
  if (e.PAYPAL_ALLOW_SIMULATOR_EVENTS) out.push("PAYPAL_ALLOW_SIMULATOR_EVENTS must be false in production");
  if (!!e.PAYPAL_CLIENT_ID !== !!e.PAYPAL_CLIENT_SECRET) out.push("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set together");
  if (raw.PAYFLOW_DEMO_MODE === "true" && !raw.AI_DAILY_CAP_USD && (e.OPENAI_API_KEY || e.ANTHROPIC_API_KEY)) out.push("a public demo with AI enabled needs AI_DAILY_CAP_USD");
  return out;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}

export type IntegrationStatus = {
  configured: boolean;
  missing: string[];
};

export function integrationStatus() {
  const e = env();
  const check = (vars: Record<string, string | undefined>): IntegrationStatus => {
    const missing = Object.entries(vars)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return { configured: missing.length === 0, missing };
  };
  return {
    paypal: check({ PAYPAL_CLIENT_ID: e.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: e.PAYPAL_CLIENT_SECRET }),
    paypalWebhooks: check({ PAYPAL_WEBHOOK_ID: e.PAYPAL_WEBHOOK_ID }),
    ai: e.AI_PROVIDER === "openai" ? check({ OPENAI_API_KEY: e.OPENAI_API_KEY }) : check({ ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY }),
  };
}
