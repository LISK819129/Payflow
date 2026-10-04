import { and, asc, count, desc, eq, max } from "drizzle-orm";
import { db } from "../db/client";
import { actionExecutions, approvals, runSteps, workflowRuns, workflowVersions, workflows } from "../db/schema";

/** Read models for pages. Every query is scoped by workspace. */

export async function listWorkflows(workspaceId: string) {
  const rows = await db()
    .select({
      id: workflows.id,
      name: workflows.name,
      state: workflows.state,
      frozenReason: workflows.frozenReason,
      updatedAt: workflows.updatedAt,
      activeVersionId: workflows.activeVersionId,
    })
    .from(workflows)
    .where(eq(workflows.workspaceId, workspaceId))
    .orderBy(desc(workflows.updatedAt));
  const runStats = await db()
    .select({ workflowId: workflowRuns.workflowId, runs: count(), lastRun: max(workflowRuns.startedAt) })
    .from(workflowRuns)
    .where(eq(workflowRuns.workspaceId, workspaceId))
    .groupBy(workflowRuns.workflowId);
  const versions = await db()
    .select({ workflowId: workflowVersions.workflowId, latest: max(workflowVersions.version) })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflows.workspaceId, workspaceId))
    .groupBy(workflowVersions.workflowId);
  return rows.map((r) => ({
    ...r,
    runs: runStats.find((s) => s.workflowId === r.id)?.runs ?? 0,
    lastRun: runStats.find((s) => s.workflowId === r.id)?.lastRun ?? null,
    latestVersion: versions.find((v) => v.workflowId === r.id)?.latest ?? 1,
  }));
}

export async function getWorkflowForEditing(workspaceId: string, workflowId: string) {
  const [wf] = await db()
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)));
  if (!wf) return null;
  const versions = await db()
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, wf.id))
    .orderBy(desc(workflowVersions.version));
  return { wf, latest: versions[0], active: versions.find((v) => v.id === wf.activeVersionId) ?? null, versions };
}

export async function listRuns(workspaceId: string, limit = 100) {
  return db()
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
      triggerKind: workflowRuns.triggerKind,
      triggerRef: workflowRuns.triggerRef,
      triggerPayload: workflowRuns.triggerPayload,
      provenance: workflowRuns.provenance,
      outcome: workflowRuns.outcome,
      startedAt: workflowRuns.startedAt,
      finishedAt: workflowRuns.finishedAt,
      workflowId: workflows.id,
      workflowName: workflows.name,
      version: workflowVersions.version,
    })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflowRuns.versionId))
    .where(eq(workflowRuns.workspaceId, workspaceId))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(limit);
}

export async function getRun(workspaceId: string, runId: string) {
  const [row] = await db()
    .select({ run: workflowRuns, wf: workflows, version: workflowVersions })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflowRuns.versionId))
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, workspaceId)));
  if (!row) return null;
  const steps = await db().select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
  const runApprovals = await db().select().from(approvals).where(eq(approvals.runId, runId));
  const actions = await db().select().from(actionExecutions).where(eq(actionExecutions.runId, runId));
  return { ...row, steps, approvals: runApprovals, actions };
}

export async function listActions(workspaceId: string, limit = 200) {
  return db()
    .select({ ex: actionExecutions, workflowName: workflows.name, workflowId: workflows.id })
    .from(actionExecutions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, actionExecutions.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(actionExecutions.workspaceId, workspaceId))
    .orderBy(desc(actionExecutions.preparedAt))
    .limit(limit);
}
