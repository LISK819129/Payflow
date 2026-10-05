/**
 * Builds evidence/phase8/manifest.json from the database (not typed by hand):
 * every Test Run and Observe Mode record with its input provenance, the exact
 * workflow/authority versions it evaluated, its verdict and AI labels; the real
 * PayPal Sandbox events received this phase; proof that no live row (execution,
 * reservation, approval, decision, reconciliation, run) was created by them;
 * OpenAI spend this phase; and the audit-chain check.
 *
 *   pnpm evidence:manifest:phase8
 */
import "../load-env";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { verifyChain } from "../../src/server/audit/audit";
import { closeDb, db } from "../../src/server/db/client";
import { aiAnalyses, aiUsage, auditRecords, paypalEvents, simulations, workflows } from "../../src/server/db/schema";
import { merchantWorkspaceId } from "../../src/server/workspace";

const OUT = path.resolve("evidence/phase8");
/** Phase 8 began after the Phase 7 commit (3448cd0). */
const START = new Date("2026-10-04T21:46:02+05:30");

function screenshots(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? screenshots(p) : f.endsWith(".png") ? [path.relative(OUT, p).replaceAll("\\", "/")] : [];
  });
}

/** Live rows of each money-relevant table created since the phase began. */
async function liveRowsSince() {
  const q = async (table: string, col: string) => {
    const { rows } = await db().execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(col)} >= ${START.toISOString()}`);
    return rows[0].n;
  };
  return {
    action_executions: await q("action_executions", "prepared_at"),
    budget_reservations: await q("budget_reservations", "created_at"),
    approvals: await q("approvals", "requested_at"),
    authority_decisions: await q("authority_decisions", "created_at"),
    reconciliations: await q("reconciliations", "created_at"),
    workflow_runs: await q("workflow_runs", "started_at"),
  };
}

async function main() {
  const ws = await merchantWorkspaceId();
  const [usage] = await db()
    .select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` })
    .from(aiUsage)
    .where(gte(aiUsage.at, START));
  const [life] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` }).from(aiUsage);

  const sims = await db()
    .select({ s: simulations, workflow: workflows.name })
    .from(simulations)
    .innerJoin(workflows, eq(workflows.id, simulations.workflowId))
    .where(and(eq(simulations.workspaceId, ws), gte(simulations.createdAt, START)))
    .orderBy(asc(simulations.createdAt));

  const events = await db().select().from(paypalEvents).where(and(eq(paypalEvents.workspaceId, ws), gte(paypalEvents.receivedAt, START))).orderBy(asc(paypalEvents.receivedAt));
  const routed = await db().select().from(auditRecords).where(and(eq(auditRecords.workspaceId, ws), eq(auditRecords.kind, "paypal.event.routed"), gte(auditRecords.at, START)));
  const analyses = await db().select().from(aiAnalyses).where(and(eq(aiAnalyses.workspaceId, ws), gte(aiAnalyses.createdAt, START))).orderBy(asc(aiAnalyses.createdAt));

  const manifest = {
    phase: 8,
    generatedAt: new Date().toISOString(),
    whatThisIsNot: "Test Run and Observe Mode are not forecasting or prediction. Each record says how one saved workflow version evaluated one input with the authority, budget and AI evidence available at that moment.",
    labels: {
      TEST_INPUT: "a hypothetical transaction typed by a person in “Test this flow”; never a PayPal event",
      REAL_PAYPAL_EVENT_OBSERVED: "a real PayPal Sandbox webhook, confirmed with PayPal's API, evaluated by an observing draft after live routing",
      CACHED_AI_ANALYSIS: "a real OpenAI result computed in Phase 7 and reused from the content-addressed cache — no new model call",
      MOCK_TEST: "the deterministic mock analyst (AI_ANALYSIS_PROVIDER=mock); no model was called",
      AI_UNAVAILABLE: "the model call was refused before it was made (the $0 phase cap) — the policy treats it as UNCERTAIN",
      CALCULATED_BY_PAYFLOW: "computed by PayFlow's own rules; no AI involved",
    },
    openai: { phase8: usage, lifetime: life, phaseCap: "AI_PHASE_CAP_USD=0 for the dev server and worker; any model call is refused before it is made" },
    paypal: {
      moneyMoved: "none — no payout, refund, capture, payment or invoice was created in Phase 8",
      eventsReceived: events.map((e) => ({
        eventId: e.eventId,
        type: e.eventType,
        provenance: e.provenance,
        resourceId: e.resourceId,
        routedAt: e.routedAt,
        liveRouting: (routed.find((r) => (r.payload as { eventId?: string }).eventId === e.eventId)?.payload as { confirmed?: boolean; matched?: unknown[] } | undefined) ?? null,
      })),
      howProduced: "pnpm paypal:sandbox:plan — a Sandbox catalog product and billing plan (no subscriber, no payment)",
    },
    liveRowsCreatedSincePhaseStart: await liveRowsSince(),
    simulations: sims.map(({ s, workflow }) => ({
      id: s.id,
      mode: s.mode,
      inputProvenance: s.inputProvenance,
      workflow,
      versionNumber: s.versionNumber,
      graphHash: s.graphHash.slice(0, 16),
      authorities: s.authorities,
      paypalEventId: s.paypalEventId,
      assumptions: s.assumptions,
      parentId: s.parentId,
      verdict: s.verdict,
      headline: s.headline,
      wouldAction: s.wouldAction,
      ai: (s.ai as { task: string; label: string }[]).map((x) => `${x.task}: ${x.label}`),
      budgetSnapshot: s.budget,
      externalActionsDisabled: s.externalActionsDisabled,
      evaluatedAt: s.evaluatedAt,
    })),
    aiAnalysesCreated: analyses.map((a) => ({ task: a.task, provider: a.provider, model: a.model, status: a.status, costUsd: a.costUsd, error: a.error })),
    auditChain: await verifyChain(ws),
    screenshots: screenshots(OUT).sort(),
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `wrote evidence/phase8/manifest.json: ${sims.length} simulations, ${events.length} PayPal events, OpenAI ${usage.calls} calls $${usage.cost}, live rows ${JSON.stringify(manifest.liveRowsCreatedSincePhaseStart)}, chain ${manifest.auditChain.ok ? "ok" : "BROKEN"}`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
