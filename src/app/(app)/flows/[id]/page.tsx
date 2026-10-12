import { notFound } from "next/navigation";
import { FlowBuilder } from "@/components/flow/builder";
import { canAuthorize, requireUser } from "@/server/auth/current";
import { integrationStatus } from "@/server/config/env";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { getWorkflowForEditing } from "@/server/workflow/queries";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { agents, authorities } from "@/server/db/schema";
import type { AuthorityTerms } from "@/server/workflow/rule-summary";
import { cloudTestExamples, DEMO_KEYS } from "@/server/demo/setup";

export default async function FlowPage(props: PageProps<"/flows/[id]">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getWorkflowForEditing(user.workspaceId, id);
  if (!data) notFound();
  const q = await props.searchParams;
  // Suppliers the covering authorities name, so a tester picks "Acme Cloud" rather than typing an address.
  const covering = await db()
    .select()
    .from(authorities)
    .where(and(eq(authorities.workspaceId, user.workspaceId), eq(authorities.status, "ACTIVE"), sql`${authorities.workflowIds} @> ${JSON.stringify([id])}::jsonb`));
  const suppliers = covering.flatMap((a) => a.counterparties.map((c) => ({ id: c.id, name: c.name ?? c.id })));
  const terms: AuthorityTerms[] = covering.map((a) => ({
    id: a.id,
    name: a.name,
    version: a.version,
    actions: a.actions,
    counterpartyRule: a.counterpartyRule,
    counterparties: a.counterparties,
    denied: a.deniedCounterparties,
    currencies: a.currencies,
    perTransactionMax: a.perTransactionMax,
    budgetAmount: a.budgetAmount,
    budgetPeriod: a.budgetPeriod,
    purposeScope: a.purposeScope,
    expiresAt: a.expiresAt?.toISOString() ?? null,
  }));
  // Agents that may ask through this workflow (active, unexpired, scoped to it).
  const scoped = await db()
    .select({ scopes: agents.scopes, expiresAt: agents.expiresAt })
    .from(agents)
    .where(and(eq(agents.workspaceId, user.workspaceId), eq(agents.status, "ACTIVE")));
  const agentCount = scoped.filter((a) => (!a.expiresAt || a.expiresAt > new Date()) && a.scopes.some((s) => s.workflowId === id)).length;
  return (
    <FlowBuilder
      key={data.latest.id + data.latest.updatedAt.toISOString()}
      workflowId={data.wf.id}
      name={data.wf.name}
      state={data.wf.state}
      latestVersion={data.latest.version}
      latestStatus={data.latest.status}
      activeVersion={data.active?.version ?? null}
      initialGraph={data.latest.graph as WorkflowGraph}
      canAuthorize={canAuthorize(user)}
      aiConfigured={integrationStatus().ai.configured}
      provenance={data.latest.provenance}
      aiInstruction={(data.latest.compileMeta as { instruction?: string } | null)?.instruction ?? null}
      observing={data.wf.observing}
      observations={data.observations}
      autoTest={q.test === "1"}
      suppliers={suppliers}
      testExamples={data.wf.demoKey === DEMO_KEYS.cloud ? cloudTestExamples() : []}
      authorities={terms}
      agentCount={agentCount}
      isOwner={user.role === "OWNER"}
    />
  );
}
