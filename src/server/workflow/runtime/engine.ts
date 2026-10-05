import { and, asc, eq, sql } from "drizzle-orm";
import { appendAudit } from "../../audit/audit";
import { db, type Tx } from "../../db/client";
import { actionExecutions, approvals, authorityDecisions, runSteps, users, workflowRuns, workflows, workflowVersions } from "../../db/schema";
import { authorityProvider } from "../../authority";
import { requestFingerprint } from "../../authority/internal";
import { settleRunReservations } from "../../authority/ledger";
import type { AuthorityRequest, AuthorityResult } from "../../authority/types";
import type { ActionIntent } from "../../actions/types";
import { SPEC_BY_TYPE, type GraphNode, type WorkflowGraph } from "../dsl/nodes";
import { RUNTIME_PHASE } from "../dsl/validate";
import { EXECUTORS, notImplemented } from "./executors";
import { describeOutcome } from "./outcome";
import { describeExecution } from "../../actions/describe";
import { prepareExecution, runAction } from "../../actions/execute";
import { collectEvidence } from "../../intelligence/evidence";
import { aiNodeResult } from "../../intelligence/node";
import { runAnalysis } from "../../intelligence/runner";
import { gatewayFor } from "../../actions/paypal-gateway";
import { isActionNode, prepareIntent } from "../../actions/prepare";
import { checkAgentBinding, NOT_SENT_CODES } from "../../agents/binding";
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

type StepOutcome = { continue: boolean; wakeAt?: Date; execute?: string; analyze?: string };

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
    const r = await (deps.transaction ?? ((fn) => db().transaction(fn)))((tx) => step(tx, runId, deps));
    if (r.wakeAt) await deps.enqueueAdvance(runId, { startAfter: r.wakeAt });
    if (r.analyze) {
      // The model call happens outside any transaction; the step then reads the stored, validated result.
      const res = await (deps.analysis ?? { run: runAnalysis }).run(r.analyze);
      if (res === "stop") break;
      if (res === "busy") {
        await deps.enqueueAdvance(runId, { startAfter: new Date(deps.now().getTime() + 10_000) });
        break;
      }
      continue;
    }
    if (r.execute) {
      // The external call happens here, outside any transaction, under the execution's lease.
      const res = await (deps.actions ?? { execute: (id: string) => runAction(id) }).execute(r.execute);
      if (res === "simulated") break; // Test/Observe: the action is where a sandboxed run ends
      if (res === "retry_later") {
        await deps.enqueueAdvance(runId, { startAfter: new Date(deps.now().getTime() + ACTION_RETRY_MS) });
        break;
      }
      if (res === "busy") break; // another worker holds the lease and will advance the run
      continue; // "settled" or "halted": the next step reads the outcome (or suspends the run)
    }
    if (!r.continue) break;
  }
  const [run] = await (deps.transaction ?? ((fn) => db().transaction(fn)))((tx) => tx.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)));
  if (!run) throw new Error(`Run ${runId} not found`);
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

  let result: NodeResult | { kind: "execute"; executionId: string; explanation: string; output: unknown } | { kind: "analyze"; analysisId: string; explanation: string; output: unknown };
  try {
    if (SPEC_BY_TYPE[node.type]?.isAI && (SPEC_BY_TYPE[node.type]?.implementedIn ?? 99) <= RUNTIME_PHASE) {
      result = await aiNodeResult(tx, { node, ctx, run, waiting, now });
    } else if (isActionNode(node.type) && (SPEC_BY_TYPE[node.type]?.implementedIn ?? 99) <= RUNTIME_PHASE) {
      result = await actionResult(tx, { node, ctx, run, steps, title, workflow, now });
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

  if (result.kind === "analyze") {
    if (!waiting) await writeStep({ status: "WAITING", output: result.output, explanation: result.explanation });
    return { continue: false, analyze: result.analysisId };
  }

  if (result.kind === "execute") {
    // Record the execution id on the step (also when it was waiting on an authority review).
    await writeStep({ status: "WAITING", output: { ...((waiting?.output as Record<string, unknown> | null) ?? {}), ...(result.output as Record<string, unknown>) }, explanation: result.explanation });
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
    const headline = result.headline ?? describeOutcome(result.outcome, steps, graph);
    await writeStep({
      status: result.stepError ? "ERROR" : "OK",
      port: null,
      explanation: headline,
      output: { ...((waiting?.output as Record<string, unknown> | null) ?? {}), endNote: result.explanation },
      error: result.stepError ?? null,
      finishedAt: now,
    });
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
 * Action nodes. The first visit prepares the intent (or refuses, failing
 * closed), asks the authority layer whether it is authorized — CHECK and
 * RESERVE in this same transaction — and only then asks the caller to execute
 * it. A REVIEW waits for a person; a DENY ends the run before PayPal is
 * contacted. Later visits turn the settled execution into the node's result.
 */
async function actionResult(
  tx: Tx,
  a: { node: GraphNode; ctx: RunContext; run: RunRow; steps: StepRow[]; title: string; workflow: WorkflowRow; now: Date },
): Promise<NodeResult | { kind: "execute"; executionId: string; explanation: string; output: unknown }> {
  // Once an execution exists for this (run, node) it is the only source of truth: never authorize twice.
  let [ex] = await tx.select().from(actionExecutions).where(and(eq(actionExecutions.runId, a.run.id), eq(actionExecutions.nodeId, a.node.id)));
  if (!ex) {
    const p = prepareIntent({ node: a.node, ctx: a.ctx, run: a.run, steps: a.steps });
    if (!p.ok) return { kind: "error", code: p.code, message: p.message, explanation: `Refused before contacting PayPal: ${p.message}` };
    const intent = p.intent;
    if (a.run.triggerKind === "agent_request") {
      // The agent's request authorizes nothing, but it bounds what this run may do: exactly what was asked.
      const b = await checkAgentBinding(tx, a.run.id, intent, a.now);
      if (!b.ok) return { kind: "end", outcome: "blocked", explanation: b.message, headline: `Blocked before PayPal was contacted: ${b.message}`, stepError: { code: b.code, message: b.message } };
    }
    let authz: AuthorityResult | null = null;
    if (intent.movesMoney || intent.external) {
      const gate = await authorityGate(tx, a, intent);
      if ("result" in gate) return gate.result;
      authz = gate.authz;
      intent.authorization.authority = { provider: authz.provider, decisionId: authz.decisionId, outcome: authz.outcome, authorityIds: authz.authorityIds, reason: authz.reason };
    }
    ex = await prepareExecution(tx, intent, gatewayFor(intent).name);
    if (authz) await authorityProvider().linkExecution(tx, authz, ex.id);
  }
  const authorityOutcome = (ex.intent as ActionIntent).authorization.authority?.outcome ?? null;
  switch (ex.status) {
    case "SUCCEEDED":
      return {
        kind: "next",
        port: "done",
        output: { ...(ex.result as Record<string, unknown>), executionId: ex.id, paypalRefs: ex.paypalRefs, paypalStatus: ex.paypalStatus, authorityOutcome },
        explanation: describeExecution(ex),
      };
    case "FAILED": {
      const e = ex.error as { code: string; message: string; debugId?: string | null };
      if (NOT_SENT_CODES.has(e.code)) {
        return { kind: "end", outcome: "blocked", explanation: e.message, headline: `Blocked before PayPal was contacted: ${e.message}`, stepError: { code: e.code, message: e.message } };
      }
      return { kind: "error", code: e.code, message: e.message, debugId: e.debugId ?? null, explanation: `PayPal refused: ${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ""}` };
    }
    case "UNKNOWN":
      return { kind: "error", code: "OUTCOME_UNKNOWN", message: "PayPal gave no definitive answer; needs review", explanation: "No definitive answer from PayPal after retries; stopped for review" };
    default:
      return { kind: "execute", executionId: ex.id, explanation: `${a.title}: sending to PayPal Sandbox`, output: { executionId: ex.id, idempotencyKey: ex.idempotencyKey } };
  }
}

/** How long a person has to decide an authority review before it lapses. */
const REVIEW_HOURS = 24;

/**
 * The authority check for one protected action. Returns the decision when the
 * action may proceed, or the node result that stops it: wait for a person
 * (REVIEW), or end the run (DENY, rejection, expiry).
 */
async function authorityGate(
  tx: Tx,
  a: { node: GraphNode; run: RunRow; steps: StepRow[]; title: string; workflow: WorkflowRow; now: Date },
  intent: ActionIntent,
): Promise<{ authz: AuthorityResult } | { result: NodeResult }> {
  const req: AuthorityRequest = {
    workspaceId: a.run.workspaceId,
    runId: a.run.id,
    nodeId: a.node.id,
    workflowId: a.run.workflowId,
    versionId: a.run.versionId,
    kind: intent.kind,
    amount: intent.amount,
    counterparty: intent.counterparty,
    target: intent.target,
    movesMoney: intent.movesMoney,
    evidence: collectEvidence(a.steps),
  };
  const [review] = await tx.select().from(approvals).where(and(eq(approvals.runId, a.run.id), eq(approvals.nodeId, a.node.id)));
  if (review?.status === "PENDING") {
    if (review.expiresAt && review.expiresAt <= a.now) {
      await tx.update(approvals).set({ status: "EXPIRED", decidedAt: a.now }).where(eq(approvals.id, review.id));
      return { result: { kind: "end", outcome: "rejected", explanation: "Authority review expired", headline: `Authority review at “${a.title}” expired without a decision; PayPal was not contacted` } };
    }
    return { result: { kind: "wait", waitFor: "approval", explanation: `Waiting for a person: ${review.reason}` } };
  }
  if (review && review.status !== "APPROVED") {
    const why = review.status === "EXPIRED" ? "expired without a decision" : !review.decidedBy && review.note?.startsWith("Withdrawn") ? "was withdrawn (agent request cancelled)" : "was rejected by a person";
    return { result: { kind: "end", outcome: "rejected", explanation: `Authority review ${why}`, headline: `Authority review at “${a.title}” ${why}; PayPal was not contacted` } };
  }

  const authz = await authorityProvider().authorize(tx, req, { approval: review ?? null, now: a.now });
  if (authz.outcome === "DENY") {
    return {
      result: {
        kind: "end",
        outcome: "blocked",
        explanation: authz.reason,
        headline: `Denied by authority at “${a.title}”: ${authz.reason.replace(/[.\s]+$/, "")}. PayPal was not contacted`,
        stepError: { code: "AUTHORITY_DENIED", message: authz.reason },
      },
    };
  }
  if (authz.outcome === "REVIEW") {
    if (review) {
      // Approved, yet the request no longer matches what the person saw: an approval is never stretched.
      return {
        result: {
          kind: "end",
          outcome: "blocked",
          explanation: "Request changed after approval",
          headline: `Blocked at “${a.title}”: the request no longer matches what was approved`,
          stepError: { code: "APPROVAL_MISMATCH", message: authz.reason },
        },
      };
    }
    const expiresAt = new Date(a.now.getTime() + REVIEW_HOURS * 3_600_000);
    const [version] = await tx.select({ version: workflowVersions.version }).from(workflowVersions).where(eq(workflowVersions.id, a.run.versionId));
    const trigger = a.run.triggerPayload as { eventType?: string; resourceId?: string; amount?: unknown };
    const [created] = await tx
      .insert(approvals)
      .values({
        workspaceId: a.run.workspaceId,
        runId: a.run.id,
        nodeId: a.node.id,
        reason: `Authority review: ${authz.reason}`,
        summary: {
          kind: "authority_review",
          fingerprint: requestFingerprint(req),
          decisionId: authz.decisionId,
          action: { kind: intent.kind, label: a.title, amount: intent.amount, counterparty: intent.counterparty, target: intent.target },
          authorityIds: authz.authorityIds,
          evaluations: authz.evaluations,
          budget: authz.budget,
          frequency: authz.frequency,
          workflow: { id: a.workflow.id, name: a.workflow.name, version: version?.version ?? null },
          paypalContext: { triggerKind: a.run.triggerKind, eventType: trigger.eventType ?? null, resourceId: trigger.resourceId ?? null, triggerAmount: trigger.amount ?? null },
        },
        expiresAt,
      })
      .returning({ id: approvals.id });
    await tx.update(authorityDecisions).set({ approvalId: created.id }).where(eq(authorityDecisions.id, authz.decisionId));
    return {
      result: {
        kind: "wait",
        waitFor: "approval",
        wakeAt: expiresAt,
        output: { authorityReview: created.id, decisionId: authz.decisionId },
        explanation: `Needs a person: ${authz.reason.replace(/[.\s]+$/, "")}. PayPal has not been contacted`,
      },
    };
  }
  return { authz };
}

async function finish(tx: Tx, run: RunRow, status: RunRow["status"], outcome: string, now: Date) {
  await tx.update(workflowRuns).set({ status, outcome, finishedAt: now, wakeAt: null }).where(eq(workflowRuns.id, run.id));
  // Workflow-level budget/frequency reservations are settled by how the run actually ended.
  await settleRunReservations(tx, run.id);
}

export type StartRunInput = {
  workflowId: string;
  triggerKind: "paypal_event" | "manual" | "schedule" | "agent_request";
  triggerRef: string;
  triggerPayload: Record<string, unknown>;
  provenance: "REAL_PAYPAL_SANDBOX" | "USER_PROVIDED" | "SIMULATED" | "AGENT_REQUEST";
  startedBy?: string | null;
  /** Agent requests: the version the agent's request was accepted against. Refuses to run a different one. */
  expectVersionId?: string;
};

/**
 * Creates a run for a workflow's ACTIVE version. Idempotent on (version,
 * triggerRef): the same PayPal event can never start the same version twice.
 */
export async function startRun(input: StartRunInput, deps: RuntimeDeps): Promise<{ runId: string; created: boolean } | { skipped: string }> {
  const out = await db().transaction((tx) => startRunTx(tx, input));
  if ("runId" in out && out.created) await deps.enqueueAdvance(out.runId);
  return out;
}

/** startRun inside the caller's transaction (the caller enqueues the advance after commit). */
export async function startRunTx(tx: Tx, input: StartRunInput): Promise<{ runId: string; created: boolean } | { skipped: string }> {
  const [wf] = await tx.select().from(workflows).where(eq(workflows.id, input.workflowId)).for("update");
  if (!wf) return { skipped: "workflow not found" };
  if (wf.state !== "ACTIVE" || !wf.activeVersionId) return { skipped: `workflow is ${wf.state.toLowerCase()}` };
  if (input.expectVersionId && input.expectVersionId !== wf.activeVersionId) return { skipped: "the active version changed" };
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
  const agent = input.triggerKind === "agent_request" ? (input.triggerPayload as { agent?: { id: string } }).agent : undefined;
  await appendAudit(tx, {
    workspaceId: wf.workspaceId,
    actor: agent ? `agent:${agent.id}` : input.startedBy ? `user:${input.startedBy}` : "system",
    kind: "run.started",
    summary: `Workflow "${wf.name}" v${version.version} started (${input.triggerKind.replace("_", " ")})`,
    payload: { triggerRef: input.triggerRef, provenance: input.provenance, version: version.version },
    workflowId: wf.id,
    runId: run.id,
    paypalRef: (input.triggerPayload as { resourceId?: string }).resourceId ?? null,
  });
  return { runId: run.id, created: true };
}

/** Records a human decision on a waiting approval and wakes the run. */
export async function decideApproval(
  input: { approvalId: string; workspaceId: string; userId: string; decision: "APPROVED" | "REJECTED"; note?: string },
  deps: RuntimeDeps,
) {
  const res = await db().transaction(async (tx) => {
    // Only a person with authority in this workspace decides. An agent has no user id and can never get here.
    const [decider] = await tx.select({ role: users.role }).from(users).where(and(eq(users.id, input.userId), eq(users.workspaceId, input.workspaceId)));
    if (!decider || (decider.role !== "OWNER" && decider.role !== "APPROVER")) return { error: "Only owners and approvers can decide approvals", runId: undefined };
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
