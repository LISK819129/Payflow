import { rateLimit } from "./rate-limit";

/**
 * Limits on what costs money (AI) or work, sized for a judging deployment.
 * All are configurable; all are per process — PayFlow is deployed as a single
 * web instance for judging (documented in docs/DEPLOYMENT.md). The hard money
 * guard is separate and shared: assertWithinBudget reads spend from Postgres.
 */
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  compilePerUserPerHour: () => num("AI_COMPILES_PER_USER_PER_HOUR", 12),
  compilePerWorkspacePerDay: () => num("AI_COMPILES_PER_WORKSPACE_PER_DAY", 60),
  testRunsPerUserPerHour: () => num("TEST_RUNS_PER_USER_PER_HOUR", 60),
};

export type LimitResult = { ok: true } | { ok: false; error: string };

const HOUR = 3_600_000;

/** AI workflow compilation / AI edits: per person and per workspace. */
export function checkCompileLimit(userId: string, workspaceId: string): LimitResult {
  const u = rateLimit(`ai-compile:user:${userId}`, LIMITS.compilePerUserPerHour(), HOUR);
  if (!u.ok) return { ok: false, error: `You've drafted ${LIMITS.compilePerUserPerHour()} workflows with AI this hour — the limit on this server. Try again in ${Math.ceil(u.retryAfterMs / 60_000)} min, or build by hand.` };
  const w = rateLimit(`ai-compile:ws:${workspaceId}`, LIMITS.compilePerWorkspacePerDay(), 24 * HOUR);
  if (!w.ok) return { ok: false, error: "This workspace has reached today's limit for AI drafting on this server. Existing flows and Test Runs still work." };
  return { ok: true };
}

/** Test Runs may call the AI analysis nodes (cached when inputs repeat). */
export function checkTestRunLimit(userId: string): LimitResult {
  const r = rateLimit(`test-run:user:${userId}`, LIMITS.testRunsPerUserPerHour(), HOUR);
  return r.ok ? { ok: true } : { ok: false, error: `Too many test runs this hour (limit ${LIMITS.testRunsPerUserPerHour()}). Try again in ${Math.ceil(r.retryAfterMs / 60_000)} min.` };
}
