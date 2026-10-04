/**
 * Builds evidence/phase6/manifest.json from the database (not typed by hand):
 * authorities with their versions, every authority decision with its checks and
 * budget snapshot, every reservation and how it settled, approvals and their
 * human decisions, the PayPal actions they led to, AI spend, and the audit check.
 *
 *   pnpm evidence:manifest:phase6
 */
import "../load-env";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, gte, sql } from "drizzle-orm";
import { verifyChain } from "../../src/server/audit/audit";
import { closeDb, db } from "../../src/server/db/client";
import { actionExecutions, aiUsage, approvals, authorities, authorityDecisions, budgetReservations, workflows } from "../../src/server/db/schema";
import { merchantWorkspaceId } from "../../src/server/workspace";

const OUT = path.resolve("evidence/phase6");
/** Phase 6 began after the Phase 5 commit (b06c36f). */
const START = new Date("2026-10-04T09:46:16+05:30");

function screenshots(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? screenshots(p) : f.endsWith(".png") ? [path.relative(OUT, p).replaceAll("\\", "/")] : [];
  });
}

async function main() {
  const ws = await merchantWorkspaceId();
  const auths = await db().select().from(authorities).where(eq(authorities.workspaceId, ws)).orderBy(asc(authorities.name));
  const wfs = await db().select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.workspaceId, ws));
  const name = (id: string) => wfs.find((w) => w.id === id)?.name ?? id;
  const decisions = await db().select().from(authorityDecisions).where(gte(authorityDecisions.createdAt, START)).orderBy(asc(authorityDecisions.createdAt));
  const reservations = await db().select().from(budgetReservations).where(gte(budgetReservations.createdAt, START)).orderBy(asc(budgetReservations.createdAt));
  const apps = await db().select().from(approvals).where(gte(approvals.requestedAt, START)).orderBy(asc(approvals.requestedAt));
  const execs = await db().select().from(actionExecutions).where(gte(actionExecutions.preparedAt, START)).orderBy(asc(actionExecutions.preparedAt));
  const [ai] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric), 0)::text` }).from(aiUsage).where(gte(aiUsage.at, START));
  const [aiAll] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric), 0)::text` }).from(aiUsage);

  const manifest = {
    phase: 6,
    generatedAt: new Date().toISOString(),
    environment: "PayPal US Sandbox — no real money",
    labels: { REAL_PAYPAL_SANDBOX: "sent to / returned by PayPal's Sandbox API", USER_PROVIDED: "run started by a person with a typed payload", MOCK_TEST: "automated test with a fake gateway (tests/authority.test.ts)" },
    aiSpend: { phase6Calls: ai.calls, phase6CostUsd: ai.cost, lifetimeCalls: aiAll.calls, lifetimeCostUsd: aiAll.cost },
    authorities: auths.map((a) => ({
      name: a.name,
      version: a.version,
      status: a.status,
      workflows: a.workflowIds.map(name),
      actions: a.actions,
      counterpartyRule: a.counterpartyRule,
      counterparties: a.counterparties,
      denied: a.deniedCounterparties,
      currencies: a.currencies,
      perTransactionMax: a.perTransactionMax,
      budget: a.budgetAmount ? `${a.budgetAmount} ${a.currencies[0]} per ${a.budgetPeriod}` : null,
      frequency: a.maxCount ? `${a.maxCount} per ${a.countPeriod}` : null,
      expiresAt: a.expiresAt,
    })),
    decisions: decisions.map((d) => {
      const ex = execs.find((e) => e.decisionId === d.id);
      const r = d.request as { kind: string; amount: unknown; counterparty: string | null };
      return {
        at: d.createdAt,
        workflow: name(d.workflowId),
        runId: d.runId,
        provider: d.provider,
        authorities: ((d.authoritySnapshot as { name: string; version: number }[]) ?? []).map((a) => `${a.name} v${a.version}`),
        request: { kind: r.kind, amount: r.amount, counterparty: r.counterparty },
        checks: (d.evaluations as { check: string; result: string; detail: string }[]).map((e) => `${e.result.toUpperCase()} ${e.check}: ${e.detail}`),
        budget: d.budget,
        decision: d.decision,
        outcome: d.outcome,
        humanApprovalId: d.approvalId,
        paypal: ex ? { status: ex.status, ids: ex.paypalRefs, paypalStatus: ex.paypalStatus, debugId: ex.debugId, attempts: ex.attempts } : "not contacted",
      };
    }),
    reservations: reservations.map((r) => ({ scope: r.scopeKey.startsWith("authority:") ? `authority ${auths.find((a) => a.id === r.authorityId)?.name ?? r.authorityId}` : r.scopeKey, period: r.periodKey, amount: r.amount, status: r.status, override: r.override, settleReason: r.settleReason, runId: r.runId })),
    approvals: apps.map((a) => ({ requestedAt: a.requestedAt, kind: (a.summary as { kind?: string }).kind ?? "workflow_approval", status: a.status, reason: a.reason, decidedAt: a.decidedAt, note: a.note, runId: a.runId })),
    auditChain: await verifyChain(ws),
    screenshots: screenshots(OUT).sort(),
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote evidence/phase6/manifest.json: ${manifest.authorities.length} authorities, ${manifest.decisions.length} decisions, ${manifest.reservations.length} reservations, ${manifest.approvals.length} approvals, chain ${manifest.auditChain.ok ? "ok" : "BROKEN"}, AI calls ${ai.calls}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
