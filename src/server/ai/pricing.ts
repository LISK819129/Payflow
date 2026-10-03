import type { Usage } from "./types";

/**
 * Published first-party prices, USD per million tokens (checked 2026-10-03).
 * Anthropic: cache writes (5-minute TTL) 1.25× input, cache reads 0.1× input.
 * OpenAI: cached input 0.1× input (gpt-5.4-mini $0.075 vs $0.75), no write premium
 * (the adapter reports cacheWriteTokens = 0). Unknown models are priced at a
 * high fallback so the budget guard errs on the safe side.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
const FALLBACK = { input: 10, output: 50 };

/** Providers report dated snapshots (gpt-5.4-mini-2026-03-17); price them as their base model. */
export function priceFor(model: string) {
  return PRICES[model] ?? PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? FALLBACK;
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
