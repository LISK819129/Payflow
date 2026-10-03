import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { aiUsage } from "../db/schema";
import { compareDecimal } from "../workflow/dsl/decimal";
import { costOf } from "./pricing";
import type { Usage } from "./types";

/** Hard lifetime budget for real model calls (USD). */
export function aiBudgetUsd(): string {
  return process.env.AI_BUDGET_USD && /^\d+(\.\d+)?$/.test(process.env.AI_BUDGET_USD) ? process.env.AI_BUDGET_USD : "5";
}

export async function spentUsd(): Promise<string> {
  const { rows } = await db().execute<{ total: string }>(sql`select coalesce(sum(cost_usd::numeric), 0)::text as total from ai_usage`);
  return rows[0]?.total ?? "0";
}

/**
 * Refuses a call whose worst-case cost would cross the budget. Called before
 * every real model request; there is no override in code.
 */
export async function assertWithinBudget(worstCaseUsd: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const spent = await spentUsd();
  const projected = (Number(spent) + Number(worstCaseUsd)).toFixed(6);
  if (compareDecimal(projected, aiBudgetUsd()) > 0) {
    return { ok: false, message: `AI budget: $${Number(spent).toFixed(4)} of $${aiBudgetUsd()} spent; this call could cost up to $${Number(worstCaseUsd).toFixed(4)}` };
  }
  return { ok: true };
}

export async function recordUsage(input: {
  workspaceId?: string | null;
  provider: string;
  model: string;
  purpose: string;
  requestId?: string | null;
  usage?: Usage;
  ok: boolean;
  error?: string | null;
}) {
  const u = input.usage ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const cost = costOf(input.model, u);
  await db()
    .insert(aiUsage)
    .values({
      workspaceId: input.workspaceId ?? null,
      provider: input.provider,
      model: input.model,
      purpose: input.purpose,
      requestId: input.requestId ?? null,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      cacheReadTokens: u.cacheReadTokens,
      costUsd: cost,
      ok: input.ok,
      error: input.error?.slice(0, 500) ?? null,
    });
  return cost;
}

export async function usageSummary() {
  const { rows } = await db().execute<{ calls: number; total: string; input: number; output: number; cache_read: number }>(
    sql`select count(*)::int as calls, coalesce(sum(cost_usd::numeric),0)::text as total,
               coalesce(sum(input_tokens),0)::int as input, coalesce(sum(output_tokens),0)::int as output,
               coalesce(sum(cache_read_tokens),0)::int as cache_read
        from ai_usage`,
  );
  return { ...rows[0], budget: aiBudgetUsd() };
}
