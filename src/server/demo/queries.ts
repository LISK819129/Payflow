import { and, count, desc, eq, sql } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db/client";
import { agentRequests, agents, approvals, auditRecords, workflows } from "../db/schema";
import { DEMO_KEYS } from "./setup";

/** The environment PayFlow talks to, as shown in the UI. PayFlow refuses to boot against live PayPal. */
export function environmentLabel(): { label: string; sandbox: boolean } {
  const e = env().PAYPAL_ENV;
  return { label: e === "sandbox" ? "PayPal · Sandbox" : "PayPal · LIVE", sandbox: e === "sandbox" };
}

/** The three "Try PayFlow" starting points. They only pre-fill the real compiler; nothing is pre-computed. */
export const TRY_EXAMPLES = [
  {
    title: "Pay cloud suppliers",
    instruction: "Pay approved cloud suppliers up to $500 for infrastructure expenses. Anything outside that purpose should require my approval.",
  },
  {
    title: "Refund customers",
    instruction: "Refund customers automatically up to $100. Anything larger requires approval.",
  },
  {
    title: "Invoice and reconcile",
    instruction: "Send an invoice when a completed job is approved, and reconcile it when PayPal confirms payment.",
  },
] as const;

/** Live figures for the home page — counts of real records, nothing seeded. */
export async function homeSnapshot(workspaceId: string) {
  const [[pending], [active], [liveAgents], recent, demoFlows, [agentReqs]] = await Promise.all([
    db().select({ n: count() }).from(approvals).where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "PENDING"))),
    db().select({ n: count() }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.state, "ACTIVE"))),
    db().select({ n: count() }).from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.status, "ACTIVE"), sql`(${agents.expiresAt} is null or ${agents.expiresAt} > now())`)),
    db().select().from(auditRecords).where(eq(auditRecords.workspaceId, workspaceId)).orderBy(desc(auditRecords.seq)).limit(7),
    db().select({ id: workflows.id, name: workflows.name, demoKey: workflows.demoKey }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), sql`${workflows.demoKey} is not null`)),
    db().select({ n: count() }).from(agentRequests).where(eq(agentRequests.workspaceId, workspaceId)),
  ]);
  const [demoAgent] = await db()
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.demoKey, DEMO_KEYS.agent), eq(agents.status, "ACTIVE")))
    .orderBy(desc(agents.createdAt))
    .limit(1);
  return {
    pending: pending.n,
    activeFlows: active.n,
    activeAgents: liveAgents.n,
    agentRequests: agentReqs.n,
    recent,
    cloudFlowId: demoFlows.find((w) => w.demoKey === DEMO_KEYS.cloud)?.id ?? null,
    refundsFlowId: demoFlows.find((w) => w.demoKey === DEMO_KEYS.refunds)?.id ?? null,
    demoAgentId: demoAgent?.id ?? null,
  };
}
