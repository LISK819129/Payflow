import { and, eq, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { compileModel } from "../ai";
import { MeteredProvider } from "../ai/metered";
import { OpenAIProvider } from "../ai/openai";
import { AnthropicProvider } from "../ai/anthropic";
import { costOf } from "../ai/pricing";
import type { AIProvider, Usage } from "../ai/types";
import { env } from "../config/env";
import { db, type Tx } from "../db/client";
import { aiAnalyses } from "../db/schema";
import { frameInput, scanForInjection } from "./framing";
import { MockAnalysisProvider } from "./mock";
import { cacheKeyFor, promptHash, TASKS, type AnalysisInput, type TaskName } from "./tasks";

/**
 * Runs execution-time analyses. Content-addressed: a repeat of the same task on
 * the same inputs (same prompt/schema version, same model) reuses the stored,
 * validated result instead of paying again. Single-flight: concurrent runs that
 * need the same analysis share one call. A model never gets tools, credentials
 * or anything that can act; its answer is validated against PayFlow's schema,
 * repaired at most once, and otherwise the analysis fails (→ UNCERTAIN → review).
 */

const g = globalThis as unknown as { __analysisProvider?: AIProvider | null };

/** Test hook: use this provider for analyses (null = "not configured"). */
export function setAnalysisProviderForTests(p: AIProvider | null | undefined) {
  g.__analysisProvider = p;
}

/** The analysis provider: a test override, the mock (AI_ANALYSIS_PROVIDER=mock), or the configured model, metered. */
export function analysisProvider(workspaceId: string): AIProvider | null {
  if (g.__analysisProvider !== undefined) return g.__analysisProvider;
  const e = env();
  const choice = process.env.AI_ANALYSIS_PROVIDER ?? e.AI_PROVIDER;
  if (choice === "mock") return new MockAnalysisProvider();
  if (choice === "off") return null;
  const worst = { inputTokens: 6000, outputTokens: 3000 };
  if (choice === "openai" && e.OPENAI_API_KEY) return new MeteredProvider(new OpenAIProvider(e.OPENAI_API_KEY, compileModel()), { workspaceId }, worst);
  if (choice === "anthropic" && e.ANTHROPIC_API_KEY) return new MeteredProvider(new AnthropicProvider(e.ANTHROPIC_API_KEY, compileModel()), { workspaceId }, worst);
  return null;
}

export type AnalysisRow = typeof aiAnalyses.$inferSelect;

/** Finds or creates the analysis for exactly these inputs. Returns whether it is an already-validated result. */
export async function ensureAnalysis(tx: Tx, input: { workspaceId: string; task: TaskName; analysis: AnalysisInput; runId: string }): Promise<{ row: AnalysisRow; hit: boolean }> {
  const provider = analysisProvider(input.workspaceId);
  const model = provider?.model ?? "unconfigured";
  const { cacheKey, inputHash, docs } = cacheKeyFor(input.task, model, input.analysis);
  const t = TASKS[input.task];
  const [created] = await tx
    .insert(aiAnalyses)
    .values({
      workspaceId: input.workspaceId,
      task: input.task,
      cacheKey,
      model,
      provider: provider?.name ?? null,
      promptVersion: t.version,
      promptHash: promptHash(input.task),
      schemaName: t.schemaName,
      inputHash,
      request: { context: input.analysis.context, documents: input.analysis.documents, documentHashes: docs, firstRunId: input.runId },
    })
    .onConflictDoNothing({ target: [aiAnalyses.workspaceId, aiAnalyses.cacheKey] })
    .returning();
  if (created) return { row: created, hit: false };
  const [existing] = await tx.select().from(aiAnalyses).where(and(eq(aiAnalyses.workspaceId, input.workspaceId), eq(aiAnalyses.cacheKey, cacheKey)));
  if (existing.status === "OK") {
    await tx.update(aiAnalyses).set({ hits: sql`${aiAnalyses.hits} + 1`, lastHitAt: new Date() }).where(eq(aiAnalyses.id, existing.id));
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: "system",
      kind: "ai.analysis.cache_hit",
      summary: `${input.task} analysis reused from cache (no model call)`,
      payload: { analysisId: existing.id, cacheKey, model: existing.model, promptVersion: existing.promptVersion },
      runId: input.runId,
    });
    return { row: existing, hit: true };
  }
  // A failure from an earlier run is retried for a new request (after a short pause), never silently reused.
  if (existing.status === "FAILED" && existing.completedAt && Date.now() - existing.completedAt.getTime() > 30_000) {
    const [reset] = await tx.update(aiAnalyses).set({ status: "PENDING", attempts: 0, leaseUntil: null, error: null }).where(eq(aiAnalyses.id, existing.id)).returning();
    return { row: reset, hit: false };
  }
  return { row: existing, hit: false };
}

const sumUsage = (a: Usage | undefined, b: Usage | undefined): Usage => ({
  inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
  outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0),
  cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
});

const MAX_ATTEMPTS = 2;

/**
 * Performs a PENDING analysis outside any transaction. Only the caller that
 * claims the lease calls the model; others wait briefly for its result.
 */
export async function runAnalysis(analysisId: string): Promise<"done" | "busy"> {
  const [claimed] = await db()
    .update(aiAnalyses)
    .set({ attempts: sql`${aiAnalyses.attempts} + 1`, leaseUntil: sql`now() + interval '120 seconds'` })
    .where(and(eq(aiAnalyses.id, analysisId), eq(aiAnalyses.status, "PENDING"), sql`(${aiAnalyses.leaseUntil} is null or ${aiAnalyses.leaseUntil} < now())`))
    .returning();
  if (!claimed) {
    // Someone else is calling the model for these exact inputs: wait for their answer rather than paying twice.
    for (let i = 0; i < 90; i++) {
      const [r] = await db().select({ status: aiAnalyses.status }).from(aiAnalyses).where(eq(aiAnalyses.id, analysisId));
      if (!r || r.status !== "PENDING") return "done";
      await new Promise((res) => setTimeout(res, 500));
    }
    return "busy";
  }

  const fail = async (code: string, message: string, extra: { usage?: Usage; model?: string; repairs?: number } = {}) => {
    const done = claimed.attempts >= MAX_ATTEMPTS || code === "NOT_CONFIGURED" || code === "BUDGET_EXHAUSTED";
    await db()
      .update(aiAnalyses)
      .set({
        status: done ? "FAILED" : "PENDING",
        // Release the lease outright. Setting it to now() could round *up* (millisecond column), and the
        // immediate re-claim below (lease_until < now()) would then fail and wait on its own lease.
        leaseUntil: null,
        error: `${code}: ${message}`.slice(0, 500),
        validation: { ok: false, code, repairs: extra.repairs ?? 0 },
        usage: extra.usage ?? null,
        costUsd: extra.usage ? costOf(extra.model ?? claimed.model, extra.usage) : "0",
        completedAt: done ? new Date() : null,
      })
      .where(eq(aiAnalyses.id, analysisId));
    if (!done) return runAnalysis(analysisId);
    await db().transaction((tx) =>
      appendAudit(tx, {
        workspaceId: claimed.workspaceId,
        actor: "system",
        kind: "ai.analysis.failed",
        summary: `${claimed.task} analysis unavailable (${code}); treated as UNCERTAIN`,
        payload: { analysisId, code, message: message.slice(0, 300), attempts: claimed.attempts },
      }),
    );
    return "done" as const;
  };

  const provider = analysisProvider(claimed.workspaceId);
  if (!provider) return fail("NOT_CONFIGURED", "No AI provider is configured for analysis");
  const task = claimed.task as TaskName;
  const t = TASKS[task];
  const req = claimed.request as AnalysisInput;
  const framed = frameInput(req.context, req.documents);

  let r = await provider.analyze({ task, instructions: t.instructions, input: framed.text, schema: t.schema, schemaName: t.schemaName });
  let usage = r.usage;
  let repairs = 0;
  if (!r.ok && r.code === "MALFORMED_OUTPUT") {
    // One controlled repair: same fenced input, plus PayFlow's note on what was wrong. Never more.
    repairs = 1;
    r = await provider.analyze({
      task,
      instructions: t.instructions,
      input: `${framed.text}\n\nPAYFLOW NOTE (trusted): your previous answer did not match the required schema (${r.message.slice(0, 200)}). Answer again with only the JSON object.`,
      schema: t.schema,
      schemaName: t.schemaName,
    });
    usage = sumUsage(usage, r.usage);
  }
  if (!r.ok) return fail(r.code, r.message, { usage, model: r.model, repairs });

  // Defence in depth: re-parse with PayFlow's own schema whatever the provider claims.
  const parsed = t.schema.safeParse(r.value);
  if (!parsed.success) return fail("MALFORMED_OUTPUT", parsed.error.issues[0]?.message ?? "schema mismatch", { usage, model: r.model, repairs });

  const cost = costOf(r.model, usage ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
  await db().transaction(async (tx) => {
    await tx
      .update(aiAnalyses)
      .set({
        status: "OK",
        leaseUntil: null,
        model: r.model,
        provider: provider.name,
        output: parsed.data as Record<string, unknown>,
        validation: { ok: true, repairs, injectionPatterns: scanForInjection(req.documents) },
        usage: usage ?? null,
        costUsd: cost,
        error: null,
        completedAt: new Date(),
      })
      .where(eq(aiAnalyses.id, analysisId));
    await appendAudit(tx, {
      workspaceId: claimed.workspaceId,
      actor: "ai",
      kind: "ai.analysis.completed",
      summary: `${task} analysis by ${provider.name} ${r.model} (${t.version})${repairs ? " after one repair" : ""} · $${cost}`,
      payload: { analysisId, model: r.model, promptVersion: t.version, promptHash: claimed.promptHash, inputHash: claimed.inputHash, usage, repairs },
    });
  });
  return "done";
}
