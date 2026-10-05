import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentRequests, agents, runSteps, users, workflows } from "../db/schema";
import type { AINodeOutput } from "../intelligence/node";
import { SPEC_BY_TYPE } from "../workflow/dsl/nodes";
import { verifyReceipt, type IntentReceipt, type ReceiptLink } from "./receipt";
import { statusView } from "./status";

/** Read models for the owner's Agents pages and the agent banner on executions. Scoped by workspace. */

export async function listAgents(workspaceId: string) {
  const rows = await db().select().from(agents).where(eq(agents.workspaceId, workspaceId)).orderBy(asc(agents.status), desc(agents.createdAt));
  const wfs = await db().select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.workspaceId, workspaceId));
  const out = [];
  for (const a of rows) {
    const recent = await db().select().from(agentRequests).where(eq(agentRequests.agentId, a.id)).orderBy(desc(agentRequests.createdAt)).limit(6);
    out.push({ ...a, scopeNames: a.scopes.map((s) => ({ ...s, name: wfs.find((w) => w.id === s.workflowId)?.name ?? "(deleted workflow)" })), recent });
  }
  return out;
}

export async function getAgent(workspaceId: string, id: string) {
  const [a] = await db()
    .select({ a: agents, ownerEmail: users.email })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.ownerId))
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
  if (!a) return null;
  const wfs = await db().select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.workspaceId, workspaceId));
  const requests = await db().select().from(agentRequests).where(eq(agentRequests.agentId, id)).orderBy(desc(agentRequests.createdAt)).limit(50);
  return { ...a.a, ownerEmail: a.ownerEmail, scopeNames: a.a.scopes.map((s) => ({ ...s, name: wfs.find((w) => w.id === s.workflowId)?.name ?? "(deleted workflow)" })), requests };
}

export type AgentRequestView = NonNullable<Awaited<ReturnType<typeof getAgentRequestView>>>;

/** Everything the pipeline shows for one agent request. */
export async function getAgentRequestView(workspaceId: string, by: { reference?: string; runId?: string }) {
  const where = by.reference ? eq(agentRequests.reference, by.reference) : eq(agentRequests.runId, by.runId ?? "00000000-0000-0000-0000-000000000000");
  const [ar] = await db().select().from(agentRequests).where(and(where, eq(agentRequests.workspaceId, workspaceId)));
  if (!ar) return null;
  const [agent] = await db().select({ a: agents, ownerEmail: users.email }).from(agents).innerJoin(users, eq(users.id, agents.ownerId)).where(eq(agents.id, ar.agentId));
  const status = await statusView(ar);
  const verification = await verifyReceipt(db(), ar);
  const steps = ar.runId ? await db().select().from(runSteps).where(eq(runSteps.runId, ar.runId)).orderBy(asc(runSteps.seq)) : [];
  const intelligence = steps
    .filter((s) => SPEC_BY_TYPE[s.nodeType]?.isAI && s.status === "OK" && s.output)
    .map((s) => {
      const o = s.output as AINodeOutput;
      return { task: o.task, source: o.source, verdict: o.classification ?? o.verdict ?? o.level ?? (o.status === "UNAVAILABLE" ? "UNAVAILABLE" : "done"), cached: o.cached, injection: !!o.injection?.detected };
    });
  return { ar, receipt: ar.receipt as IntentReceipt, links: ar.links as ReceiptLink[], agent: agent.a, ownerEmail: agent.ownerEmail, status, verification, intelligence };
}
