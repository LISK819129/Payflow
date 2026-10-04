"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canAuthorize, requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { workflowVersions, workflows } from "@/server/db/schema";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import type { Issue } from "@/server/workflow/dsl/validate";
import { runtimeDeps } from "@/server/workflow/runtime/deps";
import { decideApproval, startRun } from "@/server/workflow/runtime/engine";
import { syncSchedule } from "@/server/workflow/schedule";
import { activateLatest, createWorkflow, saveDraft, setWorkflowState } from "@/server/workflow/service";

export type ActionResult = { ok: true; message?: string; version?: number } | { ok: false; error: string; issues?: Issue[] };

export async function createWorkflowAction(form: FormData) {
  const user = await requireUser();
  const name = String(form.get("name") ?? "").trim() || "Untitled flow";
  const r = await createWorkflow({ workspaceId: user.workspaceId, userId: user.id, name });
  if (!r.ok) throw new Error(r.error);
  redirect(`/flows/${r.workflowId}`);
}

export async function saveDraftAction(workflowId: string, graph: WorkflowGraph): Promise<ActionResult> {
  const user = await requireUser();
  const r = await saveDraft({ workspaceId: user.workspaceId, userId: user.id, workflowId, graph });
  if (!r.ok) return { ok: false, error: r.error, issues: "issues" in r ? r.issues : undefined };
  revalidatePath(`/flows/${workflowId}`);
  return { ok: true, version: r.version, message: `Draft v${r.version} saved` };
}

export async function activateAction(workflowId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can activate workflows" };
  const r = await activateLatest({ workspaceId: user.workspaceId, userId: user.id, workflowId });
  if (!r.ok) return { ok: false, error: r.error, issues: "issues" in r ? r.issues : undefined };
  const [v] = await db().select({ graph: workflowVersions.graph }).from(workflowVersions).where(eq(workflowVersions.id, r.versionId));
  await syncSchedule(workflowId, v.graph as WorkflowGraph);
  revalidatePath(`/flows/${workflowId}`);
  revalidatePath("/flows");
  return { ok: true, version: r.version, message: `v${r.version} is active` };
}

export async function setStateAction(workflowId: string, to: "PAUSED" | "ACTIVE"): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can change workflow state" };
  const r = await setWorkflowState({ workspaceId: user.workspaceId, userId: user.id, workflowId, to });
  if (!r.ok) return { ok: false, error: r.error };
  for (const runId of r.wake) await runtimeDeps.enqueueAdvance(runId);
  revalidatePath(`/flows/${workflowId}`);
  return { ok: true, message: to === "PAUSED" ? "Paused" : "Active" };
}

/** Manual run with a user-provided payload. Labelled USER_PROVIDED everywhere. */
export async function manualRunAction(workflowId: string, payloadJson: string, submissionKey: string): Promise<ActionResult & { runId?: string }> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can start runs" };
  // The dialog's key makes the start idempotent: a resubmission returns the same run, never a second one.
  if (!/^[0-9a-f-]{36}$/.test(submissionKey)) return { ok: false, error: "Missing submission key" };
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson || "{}");
  } catch {
    return { ok: false, error: "Payload is not valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "Payload must be a JSON object" };
  const [wf] = await db()
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, user.workspaceId)));
  if (!wf) return { ok: false, error: "Workflow not found" };
  const r = await startRun(
    {
      workflowId,
      triggerKind: "manual",
      triggerRef: `manual:${submissionKey}`,
      triggerPayload: payload as Record<string, unknown>,
      provenance: "USER_PROVIDED",
      startedBy: user.id,
    },
    runtimeDeps,
  );
  if (!("runId" in r)) return { ok: false, error: `Not started: ${r.skipped}` };
  return { ok: true, runId: r.runId, message: r.created ? "Run started" : "Already started — showing the existing run" };
}

export async function decideApprovalAction(approvalId: string, decision: "APPROVED" | "REJECTED", note?: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can decide approvals" };
  const r = await decideApproval({ approvalId, workspaceId: user.workspaceId, userId: user.id, decision, note }, runtimeDeps);
  if (r.error) return { ok: false, error: r.error };
  revalidatePath("/executions");
  revalidatePath("/approvals");
  return { ok: true, message: decision === "APPROVED" ? "Approved" : "Rejected" };
}
