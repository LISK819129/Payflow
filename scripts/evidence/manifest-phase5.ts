/**
 * Builds evidence/phase5/manifest.json from the database (not typed by hand):
 * every PayPal action PayFlow executed with its real Sandbox ids, status,
 * debug_id, authorising gates and webhook confirmation; the reconciliations;
 * the PayPal events received; AI spend; and the audit-chain check. No secrets.
 *
 *   pnpm evidence:manifest:phase5
 */
import "../load-env";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, gte, inArray, sql } from "drizzle-orm";
import { verifyChain } from "../../src/server/audit/audit";
import { closeDb, db } from "../../src/server/db/client";
import { actionExecutions, aiUsage, paypalEvents, reconciliations, workflowRuns, workflows } from "../../src/server/db/schema";
import { merchantWorkspaceId } from "../../src/server/workspace";

const OUT = path.resolve("evidence/phase5");
/** Phase 5 began after the Phase 4.1 commit (6528bd2). */
const PHASE5_START = new Date("2026-10-04T08:44:37+05:30");

function screenshots(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? screenshots(p) : f.endsWith(".png") ? [path.relative(OUT, p).replaceAll("\\", "/")] : [];
  });
}

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const actions = await db()
    .select({ ex: actionExecutions, workflow: workflows.name, runStatus: workflowRuns.status, runOutcome: workflowRuns.outcome })
    .from(actionExecutions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, actionExecutions.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(actionExecutions.workspaceId, workspaceId))
    .orderBy(asc(actionExecutions.preparedAt));
  const events = await db()
    .select({ eventId: paypalEvents.eventId, eventType: paypalEvents.eventType, resourceId: paypalEvents.resourceId, verification: paypalEvents.verification, provenance: paypalEvents.provenance, receivedAt: paypalEvents.receivedAt, routedAt: paypalEvents.routedAt })
    .from(paypalEvents)
    .where(gte(paypalEvents.receivedAt, PHASE5_START))
    .orderBy(asc(paypalEvents.receivedAt));
  const recs = await db().select().from(reconciliations).where(eq(reconciliations.workspaceId, workspaceId)).orderBy(asc(reconciliations.createdAt));
  const ai = await db()
    .select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric), 0)::text` })
    .from(aiUsage)
    .where(gte(aiUsage.at, PHASE5_START));
  const aiTotal = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric), 0)::text` }).from(aiUsage);
  const confirmingIds = actions.map((a) => a.ex.confirmedByEventId).filter((x): x is string => !!x);
  const confirming = confirmingIds.length ? await db().select({ eventId: paypalEvents.eventId, eventType: paypalEvents.eventType }).from(paypalEvents).where(inArray(paypalEvents.eventId, confirmingIds)) : [];
  const chain = await verifyChain(workspaceId);

  const manifest = {
    phase: 5,
    generatedAt: new Date().toISOString(),
    environment: "PayPal US Sandbox — no real money",
    labels: { REAL_PAYPAL_SANDBOX: "created or read on PayPal's Sandbox API", USER_PROVIDED: "run started by a person with a typed payload", MOCK_TEST: "automated test with a fake gateway (see tests/actions.test.ts)" },
    aiSpend: { phase5Calls: ai[0].calls, phase5CostUsd: ai[0].cost, lifetimeCalls: aiTotal[0].calls, lifetimeCostUsd: aiTotal[0].cost },
    actions: actions.map(({ ex, workflow, runStatus, runOutcome }) => ({
      at: ex.preparedAt,
      workflow,
      kind: ex.kind,
      runId: ex.runId,
      runStatus,
      runOutcome,
      status: ex.status,
      attempts: ex.attempts,
      amount: ex.amountValue ? `${ex.amountValue} ${ex.currency}` : null,
      counterparty: ex.counterparty,
      target: ex.targetRef,
      paypalIds: ex.paypalRefs,
      paypalStatus: ex.paypalStatus,
      debugId: ex.debugId,
      failure: ex.error ? { code: (ex.error as { code?: string }).code, status: (ex.error as { status?: number }).status ?? null } : null,
      authorisedBy: ((ex.authorization as { gates?: { nodeId: string; port: string }[] } | null)?.gates ?? []).map((g) => `${g.nodeId}→${g.port}`),
      idempotencyKey: ex.idempotencyKey,
      confirmedBy: ex.confirmedByEventId ? { eventId: ex.confirmedByEventId, eventType: confirming.find((c) => c.eventId === ex.confirmedByEventId)?.eventType ?? null } : null,
      latestEvent: ex.lastEventType ? `${ex.lastEventType}${ex.lastEventStatus ? ` · ${ex.lastEventStatus}` : ""}` : null,
      recoveredAfterLostReply: (ex.result as { recoveredAfterLostReply?: boolean } | null)?.recoveredAfterLostReply ?? false,
      provenance: ex.provenance,
    })),
    reconciliations: recs.map((r) => ({ invoiceId: r.invoiceId, invoiceStatus: r.invoiceStatus, invoiceAmount: r.invoiceAmount, paymentAmount: r.paymentAmount, currency: r.currency, paymentRef: r.paymentRef, runId: r.runId })),
    paypalEventsReceived: events,
    auditChain: chain,
    screenshots: screenshots(OUT).sort(),
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote evidence/phase5/manifest.json: ${manifest.actions.length} actions, ${events.length} events, ${manifest.screenshots.length} screenshots, chain ${chain.ok ? "ok" : "BROKEN"}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
