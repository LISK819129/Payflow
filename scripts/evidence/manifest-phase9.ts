/**
 * Builds evidence/phase9/manifest.json from the database (not typed by hand):
 * the agents (never their credentials), every agent request with its state,
 * reasons, Intent Receipt verification and receipt chain, the PayPal actions
 * those requests caused (with the webhook events that confirmed them), AI
 * spend this phase, and the audit-chain check.
 *
 *   pnpm evidence:manifest:phase9
 */
import "../load-env";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { verifyReceipt, type IntentReceipt, type ReceiptLink } from "../../src/server/agents/receipt";
import { statusView } from "../../src/server/agents/status";
import { verifyChain } from "../../src/server/audit/audit";
import { closeDb, db } from "../../src/server/db/client";
import { actionExecutions, agentRequests, agents, aiUsage, auditRecords } from "../../src/server/db/schema";
import { merchantWorkspaceId } from "../../src/server/workspace";

const OUT = path.resolve("evidence/phase9");
/** Phase 9 began after the Phase 8 commit (6a8bfac). */
const START = new Date("2026-10-05T08:12:24+05:30");

function files(dir: string, ext: string[]): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.some((e) => f.endsWith(e)) ? [path.relative(OUT, p).replaceAll("\\", "/")] : [];
  });
}

async function main() {
  const ws = await merchantWorkspaceId();
  const usage = await db()
    .select({ purpose: aiUsage.purpose, model: aiUsage.model, calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text`, failed: sql<number>`count(*) filter (where not ${aiUsage.ok})::int` })
    .from(aiUsage)
    .where(gte(aiUsage.at, START))
    .groupBy(aiUsage.purpose, aiUsage.model);
  const [phase] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` }).from(aiUsage).where(gte(aiUsage.at, START));
  const [life] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` }).from(aiUsage);

  const agentRows = await db().select().from(agents).where(eq(agents.workspaceId, ws)).orderBy(asc(agents.createdAt));
  const requests = await db().select().from(agentRequests).where(and(eq(agentRequests.workspaceId, ws), gte(agentRequests.createdAt, START))).orderBy(asc(agentRequests.createdAt));
  const views = [];
  for (const ar of requests) {
    const s = await statusView(ar);
    const v = await verifyReceipt(db(), ar);
    const r = (ar.receipt as IntentReceipt).request;
    const [ex] = ar.runId ? await db().select().from(actionExecutions).where(eq(actionExecutions.runId, ar.runId)) : [];
    views.push({
      reference: ar.reference,
      request_id: ar.requestId,
      mode: ar.mode,
      asked: `${r.action.replace("paypal.", "")} ${r.amount.value} ${r.amount.currency} → ${r.counterparty ?? r.capture_id}`,
      purpose: r.purpose,
      state: s.state,
      reasons: s.reasons.map((x) => `${x.code} [${x.source}]`),
      authority: s.authority,
      human_review: s.human_review,
      test: s.test,
      paypal: ex
        ? { label: "REAL_PAYPAL_SANDBOX", status: ex.status, ids: ex.paypalRefs, paypal_status: ex.paypalStatus, debug_id: ex.debugId, confirmed_by_webhook_event: ex.confirmedByEventId, attempts: ex.attempts }
        : { label: "NOT CONTACTED", contacted: false },
      receipt: { hash: ar.receiptHash, verified: v.ok, problems: v.problems, chain: (ar.links as ReceiptLink[]).map((l) => `${l.seq}. ${l.kind}${l.kind === "final" ? `=${(l.data as { state: string }).state}` : ""}`) },
      run_id: ar.runId,
      simulation_id: ar.simulationId,
    });
  }
  const refusals = await db()
    .select({ at: auditRecords.at, kind: auditRecords.kind, summary: auditRecords.summary })
    .from(auditRecords)
    .where(and(eq(auditRecords.workspaceId, ws), gte(auditRecords.at, START), sql`${auditRecords.kind} in ('agent.auth.refused','agent.revoked','agent.registered','agent.credential.rotated','agent.request.withdrawn')`))
    .orderBy(asc(auditRecords.at));

  const manifest = {
    phase: 9,
    generatedAt: new Date().toISOString(),
    principle: "The agent asks. PayFlow decides (identity → scope → intent receipt → authority → intelligence → person if needed). PayPal settles.",
    labels: {
      REAL_EXTERNAL_AGENT: "an OpenAI model (Responses API) whose MCP client runs on OpenAI's platform, calling PayFlow's MCP server over the public tunnel with the agent's bearer credential only (external-agent/*.json)",
      REAL_MCP_CLIENT: "the official MCP TypeScript SDK client over HTTP through the public tunnel (mcp/*.json)",
      REAL_OPENAI: "PayFlow's own AI evidence nodes (gpt-5.4-mini) analysing the agent's request",
      REAL_PAYPAL_SANDBOX: "sent to / confirmed by PayPal's Sandbox API and its verified webhooks",
      MOCK_TEST: "tests/agents.test.ts: a fake PayPal and the mock analyst (no network, $0)",
    },
    openai: { phase9: { calls: phase.calls, cost_usd: phase.cost, by_purpose: usage }, lifetime: life, phaseCapUsd: "0.50" },
    agents: agentRows.map((a) => ({ id: a.id, name: a.name, status: a.status, scopes: a.scopes, credential: `pfa_${a.credentialId}_… (hash only)`, credential_version: a.credentialVersion, expires_at: a.expiresAt, revoked_at: a.revokedAt, revoke_reason: a.revokeReason })),
    requests: views,
    gateway_events: refusals,
    auditChain: await verifyChain(ws),
    screenshots: files(OUT, [".png"]).sort(),
    transcripts: files(OUT, [".json"]).filter((f) => f !== "manifest.json").sort(),
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote evidence/phase9/manifest.json: ${views.length} requests, ${views.filter((v) => v.paypal.label === "REAL_PAYPAL_SANDBOX").length} PayPal actions, OpenAI ${phase.calls} calls $${phase.cost}, receipts ${views.every((v) => v.receipt.verified) ? "all verified" : "NOT ALL VERIFIED"}, chain ${manifest.auditChain.ok ? "ok" : "BROKEN"}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
