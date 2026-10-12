import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { settlementsFor } from "../actions/settlement";
import { db } from "../db/client";
import { actionExecutions, approvals, authorities, authorityDecisions, runSteps, users, workflowRuns, workflowVersions, workflows } from "../db/schema";
import type { BudgetSnapshot, Evaluation, FrequencySnapshot } from "../authority/types";
import { SPEC_BY_TYPE, type WorkflowGraph } from "../workflow/dsl/nodes";

/**
 * Everything a person needs to decide one approval, assembled from persisted
 * state only: the action at stake, why they are asked, which rules passed and
 * which did not, the budget, the PayPal context, and when it lapses.
 */
export type ApprovalView = {
  id: string;
  kind: "authority_review" | "workflow_approval";
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  reason: string;
  requestedAt: Date;
  expiresAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  note: string | null;
  run: { id: string; status: string; version: number; provenance: string; triggerKind: string };
  workflow: { id: string; name: string; activeVersion: number | null; state: string };
  action: { kind: string; label: string; amount: { value: string; currency: string } | null; counterparty: string | null; target: { type: string; id: string } | null } | null;
  authorities: { id: string; name: string; version: number | null; perTransactionMax?: string | null; purposeScope?: string | null }[];
  /** What the request says the money is for (shown next to the delegated purpose when Purpose fails). */
  requestedPurpose: string | null;
  evaluations: Evaluation[];
  budget: BudgetSnapshot[];
  frequency: FrequencySnapshot[];
  paypalContext: { eventType: string | null; resourceId: string | null };
  /** Set when an external AI agent made the request (Phase 9). */
  agent: { id: string; name: string; reference: string } | null;
  /** After the decision: what happened at PayPal for the action this approval covered. */
  /** settlement: PayPal's own outcome in PayFlow's words (e.g. "Awaiting recipient"), not the submission status. */
  execution: { status: string; refs: string[]; paypalStatus: string | null; settlement: string | null; failure: string | null } | null;
};

/** The first PayPal action reachable from the approval's "approved" edge. */
function nextAction(graph: WorkflowGraph, fromNodeId: string) {
  const seen = new Set<string>();
  const queue = graph.edges.filter((e) => e.from === fromNodeId && e.port === "approved").map((e) => e.to);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) continue;
    const spec = SPEC_BY_TYPE[n.type];
    if (spec?.movesMoney || spec?.external) return n;
    for (const e of graph.edges) if (e.from === id && e.port !== "error" && e.port !== "block" && e.port !== "rejected") queue.push(e.to);
  }
  return null;
}

export async function listApprovals(workspaceId: string, opts: { status?: "PENDING" | "DECIDED"; limit?: number } = {}): Promise<ApprovalView[]> {
  const rows = await db()
    .select({ a: approvals, run: workflowRuns, wf: workflows, version: workflowVersions, decider: users.name })
    .from(approvals)
    .innerJoin(workflowRuns, eq(workflowRuns.id, approvals.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflowRuns.versionId))
    .leftJoin(users, eq(users.id, approvals.decidedBy))
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        opts.status === "PENDING" ? eq(approvals.status, "PENDING") : opts.status === "DECIDED" ? inArray(approvals.status, ["APPROVED", "REJECTED", "EXPIRED"]) : undefined,
      ),
    )
    .orderBy(opts.status === "PENDING" ? asc(approvals.requestedAt) : desc(approvals.requestedAt))
    .limit(opts.limit ?? 50);
  if (rows.length === 0) return [];

  const runIds = rows.map((r) => r.run.id);
  const activeIds = [...new Set(rows.map((r) => r.wf.activeVersionId).filter((x): x is string => !!x))];
  const actives = activeIds.length ? await db().select({ id: workflowVersions.id, version: workflowVersions.version }).from(workflowVersions).where(inArray(workflowVersions.id, activeIds)) : [];
  const steps = await db().select().from(runSteps).where(inArray(runSteps.runId, runIds)).orderBy(asc(runSteps.seq));
  const execs = await db().select().from(actionExecutions).where(inArray(actionExecutions.runId, runIds));
  const settled = await settlementsFor(workspaceId, execs);
  const auths = await db().select({ id: authorities.id, name: authorities.name, version: authorities.version }).from(authorities).where(eq(authorities.workspaceId, workspaceId));
  const decisionRows = await db().select().from(authorityDecisions).where(inArray(authorityDecisions.runId, runIds));

  return rows.map(({ a, run, wf, version, decider }) => {
    const graph = version.graph as WorkflowGraph;
    const s = a.summary as Record<string, unknown>;
    const isAuthority = s.kind === "authority_review";
    const runSteps_ = steps.filter((x) => x.runId === run.id);
    let action: ApprovalView["action"] = null;
    let evaluations: Evaluation[] = [];
    let budget: BudgetSnapshot[] = [];
    let frequency: FrequencySnapshot[] = [];
    let auth: ApprovalView["authorities"] = [];
    let actionNodeId: string | null = null;

    if (isAuthority) {
      action = s.action as ApprovalView["action"];
      evaluations = (s.evaluations as Evaluation[]) ?? [];
      budget = (s.budget as BudgetSnapshot[]) ?? [];
      frequency = (s.frequency as FrequencySnapshot[]) ?? [];
      const decision = decisionRows.find((d) => d.id === s.decisionId);
      const snap = (decision?.authoritySnapshot as { id: string; name: string; version: number; perTransactionMax?: string | null; purposeScope?: string | null }[] | null) ?? [];
      auth = snap.map((x) => ({ id: x.id, name: x.name, version: x.version, perTransactionMax: x.perTransactionMax ?? null, purposeScope: x.purposeScope ?? null }));
      actionNodeId = a.nodeId;
    } else {
      // A workflow approval node: the policy results that routed the run here are the evidence.
      const target = nextAction(graph, a.nodeId);
      actionNodeId = target?.id ?? null;
      const amount = (s.amount as { value: string; currency: string } | null) ?? null;
      action = target
        ? { kind: target.type, label: target.label ?? SPEC_BY_TYPE[target.type]?.title ?? target.type, amount, counterparty: (s.counterparty as string | null) ?? null, target: null }
        : { kind: "none", label: "No PayPal action follows", amount, counterparty: (s.counterparty as string | null) ?? null, target: null };
      evaluations = runSteps_
        .filter((x) => SPEC_BY_TYPE[x.nodeType]?.isPolicy || x.nodeType === "control.condition")
        .map((x) => ({
          check: "state" as const,
          result: x.port === "pass" || x.port === "true" ? ("pass" as const) : ("review" as const),
          detail: `${graph.nodes.find((n) => n.id === x.nodeId)?.label ?? x.nodeType}: ${x.explanation}`,
        }));
      // The authority decision for the covered action, if the run already got that far.
      const d = decisionRows.filter((x) => x.runId === run.id && x.nodeId === actionNodeId).at(-1);
      if (d) {
        evaluations = [...evaluations, ...((d.evaluations as Evaluation[]) ?? [])];
        budget = (d.budget as BudgetSnapshot[]) ?? [];
      }
    }

    const ex = actionNodeId ? execs.find((e) => e.runId === run.id && e.nodeId === actionNodeId) : undefined;
    const trigger = run.triggerPayload as { eventType?: string; resourceId?: string; agent?: { id: string; name: string }; reference?: string };
    return {
      id: a.id,
      kind: isAuthority ? "authority_review" : "workflow_approval",
      status: a.status,
      reason: a.reason,
      requestedAt: a.requestedAt,
      expiresAt: a.expiresAt,
      decidedAt: a.decidedAt,
      decidedBy: decider ?? null,
      note: a.note,
      run: { id: run.id, status: run.status, version: version.version, provenance: run.provenance, triggerKind: run.triggerKind },
      workflow: { id: wf.id, name: wf.name, activeVersion: actives.find((v) => v.id === wf.activeVersionId)?.version ?? null, state: wf.state },
      action,
      authorities: auth.length ? auth : auths.filter((x) => evaluations.some((e) => e.authorityId === x.id)),
      evaluations,
      budget,
      frequency,
      paypalContext: { eventType: (isAuthority ? (s.paypalContext as { eventType?: string } | undefined)?.eventType : trigger.eventType) ?? null, resourceId: (isAuthority ? (s.paypalContext as { resourceId?: string } | undefined)?.resourceId : trigger.resourceId) ?? null },
      requestedPurpose: typeof (run.triggerPayload as { purpose?: unknown }).purpose === "string" ? ((run.triggerPayload as { purpose: string }).purpose) : null,
      agent: run.triggerKind === "agent_request" && trigger.agent ? { id: trigger.agent.id, name: trigger.agent.name, reference: trigger.reference ?? "" } : null,
      execution: ex
        ? { status: ex.status, refs: ex.paypalRefs, paypalStatus: ex.paypalStatus, settlement: settled.get(ex.id)?.label ?? null, failure: ex.status === "FAILED" ? ((ex.error as { code?: string } | null)?.code ?? "failed") : null }
        : null,
    };
  });
}

export async function pendingApprovalCount(workspaceId: string) {
  const rows = await db().select({ id: approvals.id }).from(approvals).where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "PENDING")));
  return rows.length;
}
