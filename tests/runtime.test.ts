import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "@/server/audit/audit";
import { closeDb, db } from "@/server/db/client";
import { approvals, paypalEvents, runSteps, workflowRuns, workflows } from "@/server/db/schema";
import { routePayPalEvent } from "@/server/webhooks/route-event";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { advanceRun, decideApproval, startRun } from "@/server/workflow/runtime/engine";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { activateLatest, createWorkflow, saveDraft, setWorkflowState } from "@/server/workflow/service";
import { createUser, createWorkspace, resetTestDb } from "./support/db";

let clock = new Date("2026-10-03T10:00:00Z");
const enqueued: { runId: string; startAfter?: Date }[] = [];
const deps: RuntimeDeps = {
  enqueueAdvance: async (runId, opts) => void enqueued.push({ runId, startAfter: opts?.startAfter }),
  now: () => clock,
};

beforeEach(async () => {
  await resetTestDb();
  enqueued.length = 0;
  clock = new Date("2026-10-03T10:00:00Z");
});
afterAll(closeDb);

const end = (id: string, outcome: string, message = id) => ({ id, type: "control.terminal", config: { outcome, message } });

/** Nova Labs client payment: currency check → amount limit → approval when large. */
function novaGraph(limit = "5000.00"): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "trigger.paypal_event", config: { eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] } },
      { id: "cur", type: "policy.currency", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
      { id: "lim", type: "policy.amount_limit", config: { amountRef: "trigger.amount", max: { value: limit, currency: "USD" } } },
      { id: "appr", type: "control.approval", config: { reason: "Payment above the normal range", amountRef: "trigger.amount", counterpartyRef: "trigger.payer.email" } },
      end("ok", "completed", "Payment accepted"),
      end("review_ok", "completed", "Approved after review"),
      end("rejected", "rejected", "Rejected after review"),
      end("bad_currency", "blocked", "Unexpected currency"),
    ],
    edges: [
      { from: "t", to: "cur", port: "next" },
      { from: "cur", to: "lim", port: "pass" },
      { from: "cur", to: "bad_currency", port: "block" },
      { from: "lim", to: "ok", port: "pass" },
      { from: "lim", to: "appr", port: "block" },
      { from: "appr", to: "review_ok", port: "approved" },
      { from: "appr", to: "rejected", port: "rejected" },
    ],
  } as WorkflowGraph;
}

const payment = (value: string, currency = "USD") => ({
  kind: "paypal_event",
  eventType: "PAYMENT.CAPTURE.COMPLETED",
  resourceId: "CAP-1",
  amount: { value, currency_code: currency },
  payer: { email: "ap@novalabs.test" },
});

async function setup(graph = novaGraph()) {
  const ws = await createWorkspace("PixelForge");
  const user = await createUser(ws.id);
  const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "Nova Labs", graph });
  if (!c.ok) throw new Error(JSON.stringify(c));
  const a = await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
  if (!a.ok) throw new Error(JSON.stringify(a));
  return { ws, user, workflowId: c.workflowId };
}

async function run(workflowId: string, payload: Record<string, unknown>, ref = `ref-${Math.random()}`) {
  const r = await startRun({ workflowId, triggerKind: "paypal_event", triggerRef: ref, triggerPayload: payload, provenance: "SIMULATED" }, deps);
  if (!("runId" in r)) throw new Error(r.skipped);
  return r.runId;
}

const stepsOf = (runId: string) => db().select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
const path = async (runId: string) => (await stepsOf(runId)).map((s) => `${s.nodeId}:${s.port ?? "end"}`);

describe("workflow runtime", () => {
  it("runs a normal payment straight through and records every step", async () => {
    const { ws, workflowId } = await setup();
    const runId = await run(workflowId, payment("4000.00"));
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    expect(await path(runId)).toEqual(["t:next", "cur:pass", "lim:pass", "ok:end"]);
    expect((await stepsOf(runId))[2].explanation).toMatch(/4000.00 USD is at or below 5000.00 USD/);
    expect(await verifyChain(ws.id)).toMatchObject({ ok: true });
  });

  it("pauses for approval and resumes deterministically after approve", async () => {
    const { ws, user, workflowId } = await setup();
    const runId = await run(workflowId, payment("6850.00"));
    expect(await advanceRun(runId, deps)).toBe("WAITING_APPROVAL");
    const [a] = await db().select().from(approvals).where(eq(approvals.runId, runId));
    expect(a.summary).toMatchObject({ amount: { value: "6850.00", currency: "USD" }, counterparty: "ap@novalabs.test" });

    // Advancing again while pending changes nothing.
    expect(await advanceRun(runId, deps)).toBe("WAITING_APPROVAL");
    expect(await stepsOf(runId)).toHaveLength(4);

    const d = await decideApproval({ approvalId: a.id, workspaceId: ws.id, userId: user.id, decision: "APPROVED", note: "Called Nova" }, deps);
    expect(d.error).toBeUndefined();
    expect(enqueued.at(-1)?.runId).toBe(runId);
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    expect(await path(runId)).toEqual(["t:next", "cur:pass", "lim:block", "appr:approved", "review_ok:end"]);
    // A second decision is refused.
    expect((await decideApproval({ approvalId: a.id, workspaceId: ws.id, userId: user.id, decision: "REJECTED" }, deps)).error).toMatch(/already approved/i);
  });

  it("takes the rejected path when the approver rejects", async () => {
    const { ws, user, workflowId } = await setup();
    const runId = await run(workflowId, payment("6850.00"));
    await advanceRun(runId, deps);
    const [a] = await db().select().from(approvals).where(eq(approvals.runId, runId));
    await decideApproval({ approvalId: a.id, workspaceId: ws.id, userId: user.id, decision: "REJECTED" }, deps);
    expect(await advanceRun(runId, deps)).toBe("REJECTED");
  });

  it("blocks a currency change", async () => {
    const { workflowId } = await setup();
    const runId = await run(workflowId, payment("4000.00", "EUR"));
    expect(await advanceRun(runId, deps)).toBe("BLOCKED");
    expect(await path(runId)).toEqual(["t:next", "cur:block", "bad_currency:end"]);
  });

  it("fails safe when data is missing and there is no error path", async () => {
    const { workflowId } = await setup();
    const runId = await run(workflowId, { kind: "paypal_event", eventType: "PAYMENT.CAPTURE.COMPLETED" });
    expect(await advanceRun(runId, deps)).toBe("FAILED");
    const steps = await stepsOf(runId);
    expect(steps.at(-1)).toMatchObject({ nodeId: "cur", status: "ERROR" });
  });

  it("starts each trigger at most once per version", async () => {
    const { workflowId } = await setup();
    const a = await startRun({ workflowId, triggerKind: "paypal_event", triggerRef: "WH-1", triggerPayload: payment("1.00"), provenance: "SIMULATED" }, deps);
    const b = await startRun({ workflowId, triggerKind: "paypal_event", triggerRef: "WH-1", triggerPayload: payment("1.00"), provenance: "SIMULATED" }, deps);
    expect(a).toMatchObject({ created: true });
    expect(b).toMatchObject({ created: false, runId: (a as { runId: string }).runId });
    expect(await db().select().from(workflowRuns)).toHaveLength(1);
  });

  it("keeps a running run on the version it started with when the workflow is edited", async () => {
    const { ws, user, workflowId } = await setup(novaGraph("5000.00"));
    const runId = await run(workflowId, payment("4500.00"));
    // Lower the limit to 4000 and activate v2 before the run advances.
    await saveDraft({ workspaceId: ws.id, userId: user.id, workflowId, graph: novaGraph("4000.00") });
    const act = await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId });
    expect(act).toMatchObject({ ok: true, version: 2 });
    expect(act.ok && act.changes.map((c) => ("path" in c ? `${c.path}:${c.before}→${c.after}` : c.kind))).toContain("max.value:5000.00→4000.00");

    expect(await advanceRun(runId, deps)).toBe("COMPLETED"); // v1: 4500 ≤ 5000
    const runV2 = await run(workflowId, payment("4500.00"));
    expect(await advanceRun(runV2, deps)).toBe("WAITING_APPROVAL"); // v2: 4500 > 4000
  });

  it("suspends runs of a paused workflow and resumes them", async () => {
    const { ws, user, workflowId } = await setup();
    const runId = await run(workflowId, payment("4000.00"));
    await setWorkflowState({ workspaceId: ws.id, userId: user.id, workflowId, to: "PAUSED" });
    expect(await advanceRun(runId, deps)).toBe("SUSPENDED");
    expect(await stepsOf(runId)).toHaveLength(0);
    // New runs are not started while paused.
    expect(await startRun({ workflowId, triggerKind: "manual", triggerRef: "m1", triggerPayload: {}, provenance: "USER_PROVIDED" }, deps)).toMatchObject({
      skipped: "workflow is paused",
    });
    const resumed = await setWorkflowState({ workspaceId: ws.id, userId: user.id, workflowId, to: "ACTIVE" });
    expect(resumed.ok && resumed.wake).toEqual([runId]);
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
  });

  it("a freeze node freezes this workflow and its dependents but lets the freezing run finish", async () => {
    const ws = await createWorkspace("PixelForge");
    const user = await createUser(ws.id);
    const freezeGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger.paypal_event", config: { eventTypes: ["PAYMENT.CAPTURE.REFUNDED"] } },
        { id: "fr", type: "control.freeze", config: { reason: "Related payment refunded", includeDependents: true } },
        end("e", "needs_review", "Frozen; review the audit trail"),
      ],
      edges: [
        { from: "t", to: "fr", port: "next" },
        { from: "fr", to: "e", port: "next" },
      ],
    } as WorkflowGraph;
    const guard = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "Dispute guard", graph: freezeGraph });
    const nova = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "Nova Labs", graph: novaGraph() });
    if (!guard.ok || !nova.ok) throw new Error("setup");
    await db().update(workflows).set({ dependsOn: [guard.workflowId] }).where(eq(workflows.id, nova.workflowId));
    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: guard.workflowId });
    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: nova.workflowId });

    const novaRun = await run(nova.workflowId, payment("6850.00"));
    expect(await advanceRun(novaRun, deps)).toBe("WAITING_APPROVAL");

    const guardRun = await run(guard.workflowId, { kind: "paypal_event", eventType: "PAYMENT.CAPTURE.REFUNDED" });
    expect(await advanceRun(guardRun, deps)).toBe("NEEDS_REVIEW");

    const states = await db().select({ id: workflows.id, state: workflows.state }).from(workflows);
    expect(states.every((s) => s.state === "FROZEN")).toBe(true);
    // The approval for the frozen workflow can still be decided, but the run will not move.
    const [a] = await db().select().from(approvals).where(eq(approvals.runId, novaRun));
    await decideApproval({ approvalId: a.id, workspaceId: ws.id, userId: user.id, decision: "APPROVED" }, deps);
    expect(await advanceRun(novaRun, deps)).toBe("SUSPENDED");
    // And no new runs start.
    expect(await startRun({ workflowId: nova.workflowId, triggerKind: "manual", triggerRef: "m", triggerPayload: {}, provenance: "USER_PROVIDED" }, deps)).toMatchObject({
      skipped: "workflow is frozen",
    });
    expect(await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: nova.workflowId })).toMatchObject({ ok: false });
  });

  it("waits on a timer and continues once due", async () => {
    const ws = await createWorkspace("PixelForge");
    const user = await createUser(ws.id);
    const g = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger.manual", config: {} },
        { id: "wait", type: "control.delay", config: { untilRef: "trigger.dueDate", offsetDays: 3 } },
        end("e", "completed"),
      ],
      edges: [
        { from: "t", to: "wait", port: "next" },
        { from: "wait", to: "e", port: "elapsed" },
      ],
    } as WorkflowGraph;
    const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "Reminder", graph: g });
    if (!c.ok) throw new Error("setup");
    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
    const r = await startRun({ workflowId: c.workflowId, triggerKind: "manual", triggerRef: "m", triggerPayload: { dueDate: "2026-10-05" }, provenance: "USER_PROVIDED" }, deps);
    const runId = (r as { runId: string }).runId;
    expect(await advanceRun(runId, deps)).toBe("WAITING_TIMER");
    expect(enqueued.find((e) => e.startAfter)?.startAfter?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    clock = new Date("2026-10-07T23:59:00Z");
    expect(await advanceRun(runId, deps)).toBe("WAITING_TIMER");
    clock = new Date("2026-10-08T00:00:01Z");
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
  });

  it("never double-executes a step when two workers advance the same run", async () => {
    const { workflowId } = await setup();
    const runId = await run(workflowId, payment("4000.00"));
    const results = await Promise.all([advanceRun(runId, deps), advanceRun(runId, deps), advanceRun(runId, deps)]);
    expect(results.every((r) => r === "COMPLETED")).toBe(true);
    expect(await path(runId)).toEqual(["t:next", "cur:pass", "lim:pass", "ok:end"]);
  });

  it("refuses to activate nodes whose executors don't exist yet, or invalid graphs", async () => {
    const ws = await createWorkspace("PixelForge");
    const user = await createUser(ws.id);
    const g = novaGraph();
    g.nodes.push({ id: "refund", type: "paypal.refund", config: { captureIdRef: "trigger.resourceId", note: "x" } });
    g.edges = g.edges.map((e) => (e.from === "appr" && e.port === "rejected" ? { ...e, to: "refund" } : e));
    g.edges.push({ from: "refund", to: "rejected", port: "done" }, { from: "refund", to: "bad_currency", port: "error" });
    const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "x", graph: g });
    if (!c.ok) throw new Error("setup");
    const a = await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
    expect(a.ok).toBe(false);
    expect(!a.ok && "issues" in a && a.issues?.map((i) => i.code)).toContain("not_available");
  });
});

describe("PayPal event routing", () => {
  it("starts runs for matching active workflows and holds frozen ones", async () => {
    const { ws, user, workflowId } = await setup();
    const other = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "Frozen one", graph: novaGraph() });
    if (!other.ok) throw new Error("setup");
    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: other.workflowId });
    await db().update(workflows).set({ state: "FROZEN", frozenReason: "test" }).where(eq(workflows.id, other.workflowId));

    const raw = {
      id: "WH-SIM-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: { id: "CAP-9", amount: { value: "4000.00", currency_code: "USD" }, payer: { email_address: "ap@novalabs.test" } },
    };
    const [ev] = await db()
      .insert(paypalEvents)
      .values({ workspaceId: ws.id, eventId: raw.id, eventType: raw.event_type, resourceId: "CAP-9", verification: "SIMULATOR", provenance: "SIMULATED", raw })
      .returning();
    const http = { request: async () => Promise.reject(new Error("must not be called for simulated events")) };
    const r = await routePayPalEvent(ev.id, http as never, deps);
    expect(r).toMatchObject({ routed: true });
    const runs = await db().select().from(workflowRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workflowId, provenance: "SIMULATED", triggerRef: "WH-SIM-1" });
    expect((runs[0].triggerPayload as { amount: unknown }).amount).toEqual({ value: "4000.00", currency_code: "USD" });
    expect("matched" in r && r.matched.find((m) => m.workflowId === other.workflowId)?.skipped).toBe("workflow is frozen");

    // Routing the same event again does nothing.
    expect(await routePayPalEvent(ev.id, http as never, deps)).toEqual({ skipped: "already routed" });
  });
});
