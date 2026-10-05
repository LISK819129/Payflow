"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { appendAudit } from "@/server/audit/audit";
import { canAuthorize, requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { simulations, workflows } from "@/server/db/schema";
import { checkTestRunLimit } from "@/server/security/limits";
import { simulate, type Assumption } from "@/server/simulation/run";

type Result = { ok: true; id: string } | { ok: false; error: string };

/**
 * Test Run: the user's hypothetical input through the real engine, in a
 * sandbox. The mode is fixed here; nothing a browser sends can make it LIVE.
 */
export async function testRunAction(workflowId: string, payloadJson: string): Promise<Result> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can run tests" };
  if (payloadJson.length > 64 * 1024) return { ok: false, error: "Test input is too large (64 KB at most)" };
  const limit = checkTestRunLimit(user.id);
  if (!limit.ok) return limit;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: "Test input is not valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "Test input must be an object" };
  const [wf] = await db().select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, user.workspaceId)));
  if (!wf) return { ok: false, error: "Workflow not found" };
  const kind = (payload as { kind?: string }).kind === "paypal_event" ? "paypal_event" : "manual";
  const r = await simulate({ mode: "TEST", workspaceId: user.workspaceId, workflowId, trigger: { kind, payload: payload as Record<string, unknown> }, userId: user.id });
  return r.ok ? { ok: true, id: r.id } : r;
}

/** Re-run a Test Run's exact input, assuming a person approved or rejected where it stopped. Test-only. */
export async function assumeAction(simulationId: string, nodeId: string, choice: Assumption): Promise<Result> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can run tests" };
  if (choice !== "APPROVED" && choice !== "REJECTED") return { ok: false, error: "Unknown assumption" };
  const limit = checkTestRunLimit(user.id);
  if (!limit.ok) return limit;
  const [s] = await db().select().from(simulations).where(and(eq(simulations.id, simulationId), eq(simulations.workspaceId, user.workspaceId)));
  if (!s) return { ok: false, error: "Test run not found" };
  if (s.mode !== "TEST") return { ok: false, error: "Only test runs can explore assumptions" };
  const r = await simulate({
    mode: "TEST",
    workspaceId: user.workspaceId,
    workflowId: s.workflowId,
    versionId: s.versionId,
    trigger: s.trigger as { kind: "manual" | "paypal_event"; payload: Record<string, unknown> },
    assumptions: { ...(s.assumptions as Record<string, Assumption>), [nodeId]: choice },
    parentId: s.id,
    userId: user.id,
  });
  return r.ok ? { ok: true, id: r.id } : r;
}

/** Observe Mode on/off for a workflow whose latest version is a draft. Audited. */
export async function setObservingAction(workflowId: string, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false, error: "Only owners and approvers can change Observe Mode" };
  return db().transaction(async (tx) => {
    const [wf] = await tx.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, user.workspaceId))).for("update");
    if (!wf) return { ok: false as const, error: "Workflow not found" };
    if (wf.observing === on) return { ok: true as const };
    await tx.update(workflows).set({ observing: on, observingSince: on ? new Date() : null }).where(eq(workflows.id, wf.id));
    await appendAudit(tx, {
      workspaceId: user.workspaceId,
      actor: `user:${user.id}`,
      kind: on ? "observe.enabled" : "observe.disabled",
      summary: `Observe Mode ${on ? "on" : "off"} for “${wf.name}”${on ? " — it evaluates real PayPal events with no ability to act" : ""}`,
      payload: { workflowId: wf.id },
      workflowId: wf.id,
    });
    revalidatePath(`/flows/${workflowId}`);
    return { ok: true as const };
  });
}
