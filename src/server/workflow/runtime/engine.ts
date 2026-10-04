import { and, asc, eq, sql } from "drizzle-orm";
import { appendAudit } from "../../audit/audit";
import { db, type Tx } from "../../db/client";
import { actionExecutions, approvals, runSteps, workflowRuns, workflows, workflowVersions } from "../../db/schema";
import { SPEC_BY_TYPE, type GraphNode, type WorkflowGraph } from "../dsl/nodes";
import { RUNTIME_PHASE } from "../dsl/validate";
import { EXECUTORS, notImplemented } from "./executors";
import { describeOutcome } from "./outcome";
import { describeExecution } from "../../actions/describe";
import { prepareExecution, runAction } from "../../actions/execute";
import { gatewayFor } from "../../actions/paypal-gateway";
import { isActionNode, prepareIntent } from "../../actions/prepare";
import type { NodeResult, RunContext, RunRow, RuntimeDeps, StepRow, WorkflowRow } from "./types";

const MAX_STEPS_PER_ADVANCE = 100;
const TERMINAL: RunRow["status"][] = ["COMPLETED", "BLOCKED", "REJECTED", "NEEDS_REVIEW", "FAILED"];

const outcomeStatus = {
  completed: "COMPLETED",
  blocked: "BLOCKED",
  rejected: "REJECTED",
  needs_review: "NEEDS_REVIEW",
} as const;

export function buildContext(run: RunRow, steps: StepRow[], workflow: WorkflowRow): RunContext {
  const nodes: RunContext["nodes"] = {};
  for (const s of steps) if (s.status !== "WAITING") nodes[s.nodeId] = { output: s.output ?? null, port: s.port };
  return { trigger: run.triggerPayload as Record<string, unknown>, nodes, workflow: { id: workflow.id, name: workflow.name } };
}

type StepOutcome = { continue: boolean; wakeAt?: Date; execute?: string };

/** Delay before replaying an action whose last attempt got no definitive answer. */
const ACTION_RETRY_MS = 15_000;

/**
 * Advances a run as far as it can go: through deterministic nodes until it
 * ends, waits (approval/timer), is suspended (workflow paused/frozen) or fails.
 * Each node runs in its own transaction holding a row lock on the run, so two
 * workers can never advance the same run concurrently and every step commits
 * together with its audit record.
 */
export async function advanceRun(runId: string, deps: RuntimeDeps): Promise<RunRow["status"]> {
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    const r = await db().transaction((tx) => step(tx, runId, deps));
    if (r.wakeAt) await deps.enqueueAdvance(runId, { startAfter: r.wakeAt });
    if (r.execute) {
      // The external call happens here, outside any transaction, under the execution's lease.
      const res = await runAction(r.execute);
      if (res === "retry_later") {
        await deps.enqueueAdvance(runId, { startAfter: new Date(deps.now().getTime() + ACTION_RETRY_MS) });
        break;
      }
      if (res === "busy") break; // another worker holds the lease and will advance the run
      continue;
    }
    if (!r.continue) break;
  }
  const [run] = await db().select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId));
  return run.status;
}

async function step(tx: Tx, runId: string, deps: RuntimeDeps): Promise<StepOutcome> {
  const now = deps.now();
  const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
  if (!run || TERMINAL.includes(run.status)) return { continue: false };

  const [workflow] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId));
  const [version] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId));
  const graph = version.graph as WorkflowGraph;
  const audit = (kind: string, summary: string, payload: Record<string, unknown> = {}) =>
    appendAudit(tx, { workspaceId: run.workspaceId, actor: "system", kind, summary, payload, workflowId: run.workflowId, runId: run.id });

  // A paused or frozen workflow suspends its runs, except the run that froze it.
  const halted = workflow.state === "PAUSED" || (workflow.state === "FROZEN" && workflow.frozenByRunId !== run.id);
  if (halted) {
    if (run.status !== "SUSPENDED") {
      await tx.update(workflowRuns).set({ status: "SUSPENDED" }).where(eq(workflowRuns.id, run.id));
      await audit("run.suspended", `Run suspended: workflow "${workflow.name}" is ${workflow.state.toLowerCase()}`, { workflowState: workflow.state, reason: workflow.frozenReason });
    }
    return { continue: false };
  }
  if (run.status === "SUSPENDED") {
    await tx.update(workflowRuns).set({ status: "RUNNING" }).where(eq(workflowRuns.id, run.id));
    await audit("run.resumed", `Run resumed: workflow "${workflow.name}" is active again`);
  }

  const node = graph.nodes.find((n) => n.id === run.currentNodeId);
  if (!node) {
    await finish(tx, run, "FAILED", `Run points at unknown node "${run.currentNodeId}"`, now);
    await audit("run.failed", `Run failed: unknown node "${run.currentNodeId}"`);
    return { continue: false };
  }

  const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.seq));
  const waiting = steps.find((s) => s.nodeId === node.id && s.status === "WAITING") ?? null;
  const ctx = buildContext(run, steps, workflow);
  const exec = EXECUTORS[node.type];
  const title = node.label ?? SPEC_BY_TYPE[node.type]?.title ?? node.type;

  let result: NodeResult | { kind: "execute"; executionId: string; explanation: string; output: unknown };
  try {
    if (isActionNode(node.type) && (SPEC_BY_TYPE[node.type]?.implementedIn ?? 99) <= RUNTIME_PHASE) {
      result = await actionResult(tx, { node, ctx, run, steps, waiting, title });
    } else {
      result = exec ? await exec({ tx, node, ctx, run, workflow, waiting, now }) : notImplemented(node.type);
    }
  } catch (e) {
    // Unexpected executor failure: fail safe, never guess a port.
    result = { kind: "error", code: "EXECUTOR_CRASH", message: (e as Error).message, explanation: `Node failed unexpectedly: ${(e as Error).message}` };
  }

  const nextSeq = (steps.at(-1)?.seq ?? 0) + (waiting ? 0 : 1);

  const writeStep = async (values: Partial<typeof runSteps.$inferInsert>) => {
    if (waiting) {
      await tx.update(runSteps).set(values).where(eq(runSteps.id, waiting.id));
    } else {
      await tx.insert(runSteps).values({ runId: run.id, seq: nextSeq, nodeId: node.id, nodeType: node.type, status: "OK", ...values });
    }
  };

  if (result.kind === "execute") {
    if (!waiting) await writeStep({ status: "WAITING", output: result.output, explanation: result.explanation });
    await tx.update(workflowRuns).set({ status: "RUNNING" }).where(eq(workflowRuns.id, run.id));
    return { continue: false, execute: result.executionId };
  }

  if (result.kind === "wait") {
    if (!waiting) {
      await writeStep({ status: "WAITING", output: result.output ?? null, explanation: result.explanation });
      await audit(`node.${result.waitFor === "approval" ? "approval_requested" : "waiting"}`, `${title}: ${result.explanation}`, { nodeId: node.id });
    }
    const status = result.waitFor === "approval" ? "WAITING_APPROVAL" : "WAITING_TIMER";
    await tx.update(workflowRuns).set({ status, wakeAt: result.wakeAt ?? null }).where(eq(workflowRuns.id, run.id));
    return { continue: false, wakeAt: !waiting ? result.wakeAt : undefined };
  }

  if (result.kind === "end") {
    // The run's outcome comes from its actual path; the end node's own wording is kept as a note.
    const headline = describeOutcome(result.outcome, steps, graph);
    await writeStep({ status: "OK", port: null, explanation: headline, output: { endNote: result.explanation }, finishedAt: now });
    await finish(tx, run, outcomeStatus[result.outcome], headline, now);
    await audit("run.finished", `Run ${result.outcome.replace("_", " ")}: ${headline}`, { nodeId: node.id, outcome: result.outcome, endNote: result.explanation });
    return { continue: false };
  }

  const port = result.kind === "next" ? result.port : "error";
  await writeStep({
    status: result.kind === "error" ? "ERROR" : "OK",
    port,
    output: result.kind === "next" ? (result.output ?? null) : null,
    error: result.kind === "error" ? { code: result.code, message: result.message, ...(result.debugId ? { debugId: result.debugId } : {}) } : null,
    explanation: result.explanation,
    finishedAt: now,
  });
  await audit(result.kind === "error" ? "node.error" : "node.completed", `${title}: ${result.explanation}`, {
    nodeId: node.id,
    nodeType: node.type,
    port,
  });

  const edge = graph.edges.find((e) => e.from === node.id && e.port === port);
  if (!edge) {
    const reason = result.kind === "error" ? `${title} failed and has no error path: ${result.message}` : `${title} has no "${port}" connection`;
    await finish(tx, run, "FAILED", reason, now);
    await audit("run.failed", `Run failed: ${reason}`, { nodeId: node.id });
    return { continue: false };
  }
  await tx.update(workflowRuns).set({ currentNodeId: edge.to, status: "RUNNING", wakeAt: null }).where(eq(workflowRuns.id, run.id));
  return { continue: true };
}

/**
 * Action nodes: the first visit prepares the intent (or refuses, failing
 * closed) and asks the caller to execute it; later visits turn the settled
 * execution into the node's result. Never calls PayPal itself.
 */
async function actionResult(
  tx: Tx,
  a: { node: GraphNode; ctx: RunContext; run: RunRow; steps: StepRow[]; waiting: StepRow | null; title: string },
): Promise<NodeResult | { kind: "execute"; executionId: string; explanation: string; output: unknown }> {
  let executionId = (a.waiting?.output as { executionId?: string } | null)?.executionId;
  if (!executionId) {
    const p = prepareIntent({ node: a.node, ctx: a.ctx, run: a.run, steps: a.steps });
    if (!p.ok) return { kind: "error", code: p.code, message: p.message, explanation: `Refused before contacting PayPal: ${p.message}` };
    const row = await prepareExecution(tx, p.intent, gatewayFor(p.intent).name);
    executionId = row.id;
  }
  const [ex] = await tx.select().from(actionExecutions).where(eq(actionExecutions.id, executionId));
  switch (ex.status) {
    case "SUCCEEDED":
      return {
        kind: "next",
        port: "done",
        output: { ...(ex.result as Record<string, unknown>), executionId: ex.id, paypalRefs: ex.paypalRefs, paypalStatus: ex.paypalStatus },
        explanation: describeExecution(ex),
      };
    case "FAILED": {
      const e = ex.error as { code: string; message: string; debugId?: string | null };
      return { kind: "error", code: e.code, message: e.message, debugId: e.debugId ?? null, explanation: `PayPal refused: ${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ""}` };
    }
    case "UNKNOWN":
      return { kind: "error", code: "OUTCOME_UNKNOWN", message: "PayPal gave no definitive answer; needs review", explanation: "No definitive answer from PayPal after retries; stopped for review" };
    default:
      return { kind: "execute", executionId: ex.id, explanation: `${a.title}: sending to PayPal Sandbox`, output: { executionId: ex.id, idempotencyKey: ex.idempotencyKey } };
  }
}

async function finish(tx: Tx, run: RunRow, status: RunRow["status"], outcome: string, now: Date) {
  await tx.update(workflowRuns).set({ status, outcome, finishedAt: now, wakeAt: null }).where(eq(workflowRuns.id, run.id));
}

/**
 * Creates a run for a workflow's ACTIVE version. Idempotent on (version,
 * triggerRef): the same PayPal event can never start the same version twice.
 */
export async function startRun(
  input: {
    workflowId: string;
    triggerKind: "paypal_event" | "manual" | "schedule";
    triggerRef: string;
    triggerPayload: Record<string, unknown>;
    provenance: "REAL_PAYPAL_SANDBOX" | "USER_PROVIDED" | "SIMULATED";
    startedBy?: string | null;
  },
  deps: RuntimeDeps,
): Promise<{ runId: string; created: boolean } | { skipped: string }> {
  const out = await db().transaction(async (tx) => {
    const [wf] = await tx.select().from(workflows).where(eq(workflows.id, input.workflowId)).for("update");
    if (!wf) return { skipped: "workflow not found" };
    if (wf.state !== "ACTIVE" || !wf.activeVersionId) return { skipped: `workflow is ${wf.state.toLowerCase()}` };
    const [version] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, wf.activeVersionId));
    const graph = version.graph as WorkflowGraph;
    const triggerNode = graph.nodes.find((n) => SPEC_BY_TYPE[n.type]?.category === "trigger")!;

    const [run] = await tx
      .insert(workflowRuns)
      .values({
        workspaceId: wf.workspaceId,
        workflowId: wf.id,
        versionId: version.id,
        triggerKind: input.triggerKind,
        triggerRef: input.triggerRef,
        triggerPayload: input.triggerPayload,
        provenance: input.provenance,
        currentNodeId: triggerNode.id,
        startedBy: input.startedBy ?? null,
      })
      .onConflictDoNothing({ target: [workflowRuns.versionId, workflowRuns.triggerRef] })
      .returning();
    if (!run) {
      const [existing] = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.versionId, version.id), eq(workflowRuns.triggerRef, input.triggerRef)));
      return { runId: existing.id, created: false };
    }
    await appendAudit(tx, {
      workspaceId: wf.workspaceId,
      actor: input.startedBy ? `user:${input.startedBy}` : "system",
      kind: "run.started",
      summary: `Workflow "${wf.name}" v${version.version} started (${input.triggerKind.replace("_", " ")})`,
      payload: { triggerRef: input.triggerRef, provenance: input.provenance, version: version.version },
      workflowId: wf.id,
      runId: run.id,
      paypalRef: (input.triggerPayload as { resourceId?: string }).resourceId ?? null,
    });
    return { runId: run.id, created: true };
  });
  if ("runId" in out && out.created) await deps.enqueueAdvance(out.runId);
  return out;
}

/** Records a human decision on a waiting approval and wakes the run. */
export async function decideApproval(
  input: { approvalId: string; workspaceId: string; userId: string; decision: "APPROVED" | "REJECTED"; note?: string },
  deps: RuntimeDeps,
) {
  const res = await db().transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.workspaceId, input.workspaceId)))
      .for("update");
    if (!a) return { error: "Approval not found", runId: undefined };
    if (a.status !== "PENDING") return { error: `Already ${a.status.toLowerCase()}`, runId: undefined };
    if (a.expiresAt && a.expiresAt <= deps.now()) return { error: "This approval has expired", runId: undefined };
    await tx
      .update(approvals)
      .set({ status: input.decision, decidedBy: input.userId, decidedAt: deps.now(), note: input.note?.slice(0, 500) ?? null })
      .where(eq(approvals.id, a.id));
    await appendAudit(tx, {
      workspaceId: a.workspaceId,
      actor: `user:${input.userId}`,
      kind: input.decision === "APPROVED" ? "approval.approved" : "approval.rejected",
      summary: `${input.decision === "APPROVED" ? "Approved" : "Rejected"}: ${a.reason}`,
      payload: { approvalId: a.id, nodeId: a.nodeId, note: input.note ?? null, summary: a.summary },
      runId: a.runId,
    });
    return { runId: a.runId, error: undefined };
  });
  if (res.runId) await deps.enqueueAdvance(res.runId);
  return res;
}

/** Runs waiting on timers whose time has come (safety net if a delayed job was lost). */
export async function dueTimers(now: Date) {
  return db()
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.status, "WAITING_TIMER"), sql`${workflowRuns.wakeAt} <= ${now}`));
}
