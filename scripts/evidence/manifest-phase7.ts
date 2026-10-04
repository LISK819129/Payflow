/**
 * Builds evidence/phase7/manifest.json from the database (not typed by hand):
 * every execution-time AI analysis with its provenance, cost and cache hits;
 * every Cloud procurement run with the AI evidence it produced, the authority's
 * decision and what reached PayPal; real OpenAI spend; and the audit check.
 *
 *   pnpm evidence:manifest:phase7
 */
import "../load-env";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { verifyChain } from "../../src/server/audit/audit";
import { closeDb, db } from "../../src/server/db/client";
import { actionExecutions, aiAnalyses, aiUsage, approvals, authorityDecisions, runSteps, workflowRuns, workflows } from "../../src/server/db/schema";
import type { AINodeOutput } from "../../src/server/intelligence/node";
import { merchantWorkspaceId } from "../../src/server/workspace";

const OUT = path.resolve("evidence/phase7");
/** Phase 7 began after the Phase 6 commit (49ba03e). */
const START = new Date("2026-10-04T13:49:21+05:30");

function screenshots(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? screenshots(p) : f.endsWith(".png") ? [path.relative(OUT, p).replaceAll("\\", "/")] : [];
  });
}

async function main() {
  const ws = await merchantWorkspaceId();
  const [usage] = await db()
    .select({
      calls: sql<number>`count(*)::int`,
      input: sql<number>`coalesce(sum(${aiUsage.inputTokens}),0)::int`,
      output: sql<number>`coalesce(sum(${aiUsage.outputTokens}),0)::int`,
      cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text`,
      failed: sql<number>`count(*) filter (where not ${aiUsage.ok})::int`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.at, START));
  const [life] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` }).from(aiUsage);
  const models = await db().select({ model: aiUsage.model, n: sql<number>`count(*)::int` }).from(aiUsage).where(gte(aiUsage.at, START)).groupBy(aiUsage.model);

  const analyses = await db().select().from(aiAnalyses).where(and(eq(aiAnalyses.workspaceId, ws), gte(aiAnalyses.createdAt, START))).orderBy(asc(aiAnalyses.createdAt));
  const [cloud] = await db().select().from(workflows).where(and(eq(workflows.workspaceId, ws), eq(workflows.name, "Cloud procurement")));
  const runs = await db().select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, cloud.id), gte(workflowRuns.startedAt, START))).orderBy(asc(workflowRuns.startedAt));

  const runViews = [];
  for (const r of runs) {
    const steps = await db().select().from(runSteps).where(eq(runSteps.runId, r.id)).orderBy(asc(runSteps.seq));
    const ai = steps.filter((s) => s.nodeType.startsWith("ai.") && s.output).map((s) => s.output as AINodeOutput);
    const decisions = await db().select().from(authorityDecisions).where(eq(authorityDecisions.runId, r.id)).orderBy(asc(authorityDecisions.createdAt));
    const [ex] = await db().select().from(actionExecutions).where(eq(actionExecutions.runId, r.id));
    const [ap] = await db().select().from(approvals).where(eq(approvals.runId, r.id));
    const p = r.triggerPayload as { supplierEmail?: string; amount?: { value: string }; invoice?: string };
    runViews.push({
      runId: r.id,
      request: { supplier: p.supplierEmail, amount: p.amount?.value, invoiceFirstLine: (p.invoice ?? "").split(/\\n|\n/).slice(0, 3).join(" · ") },
      ai: ai.map((o) => ({
        task: o.task,
        source: o.source,
        status: o.status,
        cached: o.cached,
        model: o.model,
        verdict: o.classification ?? o.verdict ?? o.level ?? null,
        injection: o.injection?.detected ? { codePatterns: o.injection.patterns.map((h) => h.pattern), modelFlagged: o.injection.modelFlagged } : null,
        signals: o.risk?.signals.filter((s) => s.severity === "elevated" || s.severity === "high").map((s) => `${s.label}: ${s.value}`) ?? undefined,
      })),
      authority: decisions.map((d) => ({ decision: d.decision, outcome: d.outcome, nonPassing: (d.evaluations as { check: string; result: string; detail: string; source?: string }[]).filter((e) => e.result !== "pass").map((e) => `${e.result.toUpperCase()} ${e.check} [${e.source ?? "payflow"}]: ${e.detail}`) })),
      human: ap ? { status: ap.status, note: ap.note } : null,
      paypal: ex ? { status: ex.status, ids: ex.paypalRefs, paypalStatus: ex.paypalStatus, label: "REAL_PAYPAL_SANDBOX" } : "not contacted",
      runStatus: r.status,
    });
  }

  const manifest = {
    phase: 7,
    generatedAt: new Date().toISOString(),
    labels: { REAL_OPENAI: "a real OpenAI call (gpt-5.4-mini) through the metered provider", REAL_PAYPAL_SANDBOX: "sent to / returned by PayPal's Sandbox API", MOCK_TEST: "automated test with the deterministic mock analyst (tests/intelligence.test.ts)" },
    openai: { phase7: usage, lifetime: life, models, phaseCapUsd: "0.75" },
    analyses: analyses.map((a) => ({
      task: a.task,
      status: a.status,
      provider: a.provider,
      model: a.model,
      promptVersion: a.promptVersion,
      promptHash: a.promptHash.slice(0, 16),
      inputHash: a.inputHash.slice(0, 16),
      costUsd: a.costUsd,
      cacheHits: a.hits,
      repairs: (a.validation as { repairs?: number } | null)?.repairs ?? 0,
      label: a.provider === "mock" ? "MOCK_TEST" : "REAL_OPENAI",
    })),
    cloudProcurementRuns: runViews,
    auditChain: await verifyChain(ws),
    screenshots: screenshots(OUT).sort(),
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote evidence/phase7/manifest.json: ${manifest.analyses.length} analyses, ${runViews.length} runs, OpenAI ${usage.calls} calls $${usage.cost}, chain ${manifest.auditChain.ok ? "ok" : "BROKEN"}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
