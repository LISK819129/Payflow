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
  if (parsed.data.PAYPAL_ENV === "live") {
    // PayFlow is a Sandbox product for the hackathon. Refuse to boot against
    // real money rather than trusting a config flag downstream.
    throw new Error("PAYPAL_ENV=live is not supported. PayFlow runs against PayPal Sandbox only.");
  }
  cached = parsed.data;
  return cached;
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
