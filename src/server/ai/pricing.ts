import type { Usage } from "./types";

/**
 * Published Anthropic first-party prices, USD per million tokens (checked
 * 2026-10-03). Cache writes (5-minute TTL) bill at 1.25× input, cache reads at
 * 0.1× input. Unknown models are priced at the most expensive known rate so the
 * budget guard errs on the safe side.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
const FALLBACK = { input: 10, output: 50 };

export function priceFor(model: string) {
  return PRICES[model] ?? FALLBACK;
}

/** Cost in USD as a decimal string (6 dp), computed without floating point drift. */
export function costOf(model: string, u: Usage): string {
  const p = priceFor(model);
  // Work in micro-dollars per token × 1e6 → integer arithmetic on per-million prices.
  const micros =
    u.inputTokens * p.input + u.outputTokens * p.output + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.input * 0.1;
  // micros is USD × 1e6 (because prices are per 1e6 tokens).
  // Keep 6 dp: a single small call costs fractions of a cent and must still count against the budget.
  return (Math.ceil(micros) / 1e6).toFixed(6);
}

/** Upper-bound estimate for a call before it is made. */
export function estimateCost(model: string, inputTokens: number, maxOutputTokens: number): string {
  return costOf(model, { inputTokens, outputTokens: maxOutputTokens, cacheWriteTokens: 0, cacheReadTokens: 0 });
}
