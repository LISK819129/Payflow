import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { authorities, authorityDecisions, workflowVersions, workflows } from "../db/schema";
import { SPEC_BY_TYPE, type WorkflowGraph } from "../workflow/dsl/nodes";
import { scopeKeyFor } from "./internal";
import { usageFor } from "./ledger";
import { periodWindow, type Period } from "./periods";
import type { AuthorityRow, Usage } from "./types";

export type AuthorityView = AuthorityRow & {
  workflows: { id: string; name: string; state: string }[];
  budgetUsage: (Usage & { periodLabel: string }) | null;
  countUsage: (Usage & { periodLabel: string }) | null;
  recent: (typeof authorityDecisions.$inferSelect)[];
  counts: { allow: number; review: number; deny: number };
};

export async function listAuthorities(workspaceId: string): Promise<AuthorityView[]> {
  const rows = await db().select().from(authorities).where(eq(authorities.workspaceId, workspaceId)).orderBy(desc(authorities.status), authorities.name);
  const wfs = await db().select({ id: workflows.id, name: workflows.name, state: workflows.state }).from(workflows).where(eq(workflows.workspaceId, workspaceId));
  const now = new Date();
  const out: AuthorityView[] = [];
  for (const a of rows) {
    const usage = async (p: Period | null) => {
      if (!p) return null;
      const w = periodWindow(p, now);
      const u = await db().transaction((tx) => usageFor(tx, workspaceId, scopeKeyFor(a.id), w));
      return { ...u, periodLabel: w.label };
    };
    const recent = await db()
      .select()
      .from(authorityDecisions)
      .where(sql`${authorityDecisions.authoritySnapshot} @> ${JSON.stringify([{ id: a.id }])}::jsonb`)
      .orderBy(desc(authorityDecisions.createdAt))
      .limit(6);
    const [c] = await db()
      .select({
        allow: sql<number>`count(*) filter (where ${authorityDecisions.decision} = 'ALLOW')::int`,
        review: sql<number>`count(*) filter (where ${authorityDecisions.decision} = 'REVIEW')::int`,
        deny: sql<number>`count(*) filter (where ${authorityDecisions.decision} = 'DENY')::int`,
      })
      .from(authorityDecisions)
      .where(sql`${authorityDecisions.authoritySnapshot} @> ${JSON.stringify([{ id: a.id }])}::jsonb`);
    out.push({
      ...a,
      workflows: wfs.filter((w) => a.workflowIds.includes(w.id)),
      budgetUsage: await usage(a.budgetPeriod),
      countUsage: await usage(a.countPeriod),
      recent,
      counts: c,
    });
  }
  return out;
}

export async function getAuthority(workspaceId: string, id: string) {
  const [a] = await db().select().from(authorities).where(and(eq(authorities.workspaceId, workspaceId), eq(authorities.id, id)));
  return a ?? null;
}

/** Active workflows with PayPal actions that no active authority covers: they will always ask a person. */
export async function uncoveredActions(workspaceId: string) {
  const active = await db()
    .select({ id: workflows.id, name: workflows.name, graph: workflowVersions.graph })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.activeVersionId))
    .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.state, "ACTIVE")));
  const auths = await db().select().from(authorities).where(and(eq(authorities.workspaceId, workspaceId), eq(authorities.status, "ACTIVE")));
  const gaps: { workflowId: string; workflowName: string; kinds: string[] }[] = [];
  for (const w of active) {
    const kinds = [...new Set((w.graph as WorkflowGraph).nodes.map((n) => n.type).filter((t) => SPEC_BY_TYPE[t]?.movesMoney || SPEC_BY_TYPE[t]?.external))];
    const missing = kinds.filter((k) => !auths.some((a) => a.workflowIds.includes(w.id) && a.actions.includes(k)));
    if (missing.length) gaps.push({ workflowId: w.id, workflowName: w.name, kinds: missing });
  }
  return gaps;
}
