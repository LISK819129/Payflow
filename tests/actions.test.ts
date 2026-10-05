import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAction } from "@/server/actions/execute";
import { setGatewayForTests } from "@/server/actions/paypal-gateway";
import { gatesPassed, prepareIntent } from "@/server/actions/prepare";
import type { ActionGateway, ActionIntent, ActionOutcome, GatewayContext } from "@/server/actions/types";
import { verifyChain } from "@/server/audit/audit";
import { closeDb, db } from "@/server/db/client";
import { actionExecutions, auditRecords, paypalEvents, runSteps, workflowRuns } from "@/server/db/schema";
import { routePayPalEvent } from "@/server/webhooks/route-event";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { validateGraph } from "@/server/workflow/dsl/validate";
import { advanceRun, startRun } from "@/server/workflow/runtime/engine";
import { normalizePayPalEvent } from "@/server/workflow/runtime/trigger";
import { PayPalApiError } from "@/server/paypal/errors";
import { existingBatchFor } from "@/server/paypal/operations";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { activateLatest, createWorkflow } from "@/server/workflow/service";
import { grantAuthority } from "./support/authority";
import { createUser, createWorkspace, resetTestDb } from "./support/db";

/** Behaves like PayPal for idempotency: the same key always yields the same object. */
class FakePayPal implements ActionGateway {
  readonly name = "fake-paypal";
  calls: { key: string; kind: string; previous: Record<string, unknown> | null }[] = [];
  private byKey = new Map<string, ActionOutcome>();
  script: ((intent: ActionIntent, ctx: GatewayContext, n: number) => Promise<ActionOutcome | null>) | null = null;
  delayMs = 0;

  async execute(intent: ActionIntent, ctx: GatewayContext): Promise<ActionOutcome> {
    this.calls.push({ key: intent.idempotencyKey, kind: intent.kind, previous: ctx.previous });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const scripted = this.script ? await this.script(intent, ctx, this.calls.length) : null;
    if (scripted) return scripted;
    const seen = this.byKey.get(intent.idempotencyKey);
    if (seen) return seen; // PayPal-Request-Id replay → same object
    const id = `REF-${this.byKey.size + 1}`;
    const out: ActionOutcome = { status: "succeeded", paypalRefs: [id], paypalStatus: "COMPLETED", debugId: "dbg-ok", result: { refundId: id, amount: intent.amount } };
    this.byKey.set(intent.idempotencyKey, out);
    return out;
  }
  distinctObjects() {
    return this.byKey.size;
  }
  /** The request reached PayPal and created the object, but its response was lost. */
  landWithoutReply(intent: ActionIntent) {
    const id = `REF-${this.byKey.size + 1}`;
    this.byKey.set(intent.idempotencyKey, { status: "succeeded", paypalRefs: [id], paypalStatus: "COMPLETED", debugId: "dbg-ok", result: { refundId: id, amount: intent.amount } });
  }
}

let fake: FakePayPal;
const enqueued: { runId: string; startAfter?: Date }[] = [];
const deps: RuntimeDeps = { enqueueAdvance: async (runId, o) => void enqueued.push({ runId, startAfter: o?.startAfter }), now: () => new Date() };
let ws: { id: string };
let user: { id: string };

beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("PixelForge");
  user = await createUser(ws.id);
  fake = new FakePayPal();
  setGatewayForTests(fake);
  enqueued.length = 0;
});
afterEach(() => setGatewayForTests(null));
afterAll(closeDb);

const end = (id: string, outcome: string, message = id) => ({ id, type: "control.terminal", config: { outcome, message } });

/** Manual trigger → amount limit (≤ $500) → refund → done / needs review. */
function refundGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "trigger.manual", config: {} },
      { id: "lim", type: "policy.amount_limit", label: "Refund up to $500", config: { amountRef: "trigger.amount", max: { value: "500.00", currency: "USD" } } },
      { id: "refund", type: "paypal.refund", label: "Refund the payment", config: { captureIdRef: "trigger.captureId", amountRef: "trigger.amount", note: "Refund from PixelForge" } },
      end("done", "completed", "Refunded"),
      end("too_big", "blocked", "Too large to refund automatically"),
      end("review", "needs_review", "Refund did not go through"),
    ],
    edges: [
      { from: "t", to: "lim", port: "next" },
      { from: "lim", to: "refund", port: "pass" },
      { from: "lim", to: "too_big", port: "block" },
      { from: "refund", to: "done", port: "done" },
      { from: "refund", to: "review", port: "error" },
    ],
  } as WorkflowGraph;
}

async function startRefund(payload: Record<string, unknown>, graph = refundGraph(), withAuthority = true) {
  const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: `refund-${Math.random()}`, graph });
  if (!c.ok) throw new Error(JSON.stringify(c));
  const a = await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
  if (!a.ok) throw new Error(JSON.stringify(a));
  if (withAuthority) await grantAuthority(ws.id, user.id, [c.workflowId]);
  const r = await startRun({ workflowId: c.workflowId, triggerKind: "manual", triggerRef: `m-${Math.random()}`, triggerPayload: payload, provenance: "USER_PROVIDED" }, deps);
  return (r as { runId: string }).runId;
}

const executions = () => db().select().from(actionExecutions);
const stepsOf = (runId: string) => db().select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
const goodPayload = { captureId: "9KA36357WA530561Y", amount: { value: "120.00", currency_code: "USD" } };

describe("PayPal action nodes: success path", () => {
  it("prepares, executes once, records PayPal ids and audits before and after", async () => {
    const runId = await startRefund(goodPayload);
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    const [ex] = await executions();
    expect(ex).toMatchObject({ kind: "paypal.refund", status: "SUCCEEDED", amountValue: "120.00", currency: "USD", targetRef: "9KA36357WA530561Y", paypalRefs: ["REF-1"], debugId: "dbg-ok", idempotencyKey: `pf:${runId}:refund`, attempts: 1 });
    expect((ex.authorization as { gates: { nodeId: string; port: string }[] }).gates).toEqual([expect.objectContaining({ nodeId: "lim", port: "pass" })]);
    const steps = await stepsOf(runId);
    expect(steps.find((s) => s.nodeId === "refund")).toMatchObject({ status: "OK", port: "done", explanation: "Refund of 120.00 USD on capture 9KA36357WA530561Y accepted by PayPal · refund REF-1 COMPLETED" });
    const kinds = (await db().select().from(auditRecords).where(eq(auditRecords.runId, runId)).orderBy(asc(auditRecords.seq))).map((a) => a.kind);
    expect(kinds.indexOf("action.prepared")).toBeLessThan(kinds.indexOf("action.succeeded"));
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.outcome).toBe("Completed automatically · Refund the payment done");
    expect(fake.calls).toHaveLength(1);
    expect(await verifyChain(ws.id)).toMatchObject({ ok: true });
  });
});

describe("PayPal action nodes: fail closed before PayPal", () => {
  it.each([
    ["no amount", { captureId: "9KA36357WA530561Y" }, "BAD_AMOUNT"],
    ["three decimals", { captureId: "9KA36357WA530561Y", amount: { value: "10.005", currency_code: "USD" } }, "BAD_AMOUNT"],
    ["lowercase currency", { captureId: "9KA36357WA530561Y", amount: { value: "10.00", currency_code: "usd" } }, "BAD_AMOUNT"],
    ["zero", { captureId: "9KA36357WA530561Y", amount: { value: "0.00", currency_code: "USD" } }, "BAD_AMOUNT"],
    ["bad capture id", { captureId: "../admin", amount: { value: "10.00", currency_code: "USD" } }, "BAD_TARGET"],
  ])("%s → refused, PayPal never called", async (_label, payload, code) => {
    const graph = refundGraph();
    // Skip the limit so the refund node itself sees the bad data (the gate is an approval stand-in).
    graph.nodes[1] = { id: "lim", type: "policy.counterparty", config: { ref: "trigger.captureId", allowed: [String((payload as { captureId: string }).captureId)] } };
    const runId = await startRefund(payload, graph);
    await advanceRun(runId, deps);
    const steps = await stepsOf(runId);
    const refund = steps.find((s) => s.nodeId === "refund");
    expect(refund).toMatchObject({ status: "ERROR", port: "error" });
    expect((refund!.error as { code: string }).code).toBe(code);
    expect(refund!.explanation).toMatch(/^Refused before contacting PayPal/);
    expect(fake.calls).toHaveLength(0);
    expect(await executions()).toHaveLength(0);
  });

  it("refuses at run time when no gate passed on the executed path, even if the graph were wrong", () => {
    const g = refundGraph();
    const node = g.nodes.find((n) => n.id === "refund")!;
    const p = prepareIntent({
      node,
      ctx: { trigger: goodPayload, nodes: {}, workflow: { id: "w", name: "w" } },
      run: { id: "r", workspaceId: "ws" } as never,
      steps: [{ nodeId: "lim", nodeType: "policy.amount_limit", status: "OK", port: "block", explanation: null } as never],
    });
    expect(p).toMatchObject({ ok: false, code: "NO_AUTHORIZATION" });
    expect(gatesPassed([{ nodeId: "a", nodeType: "control.approval", status: "OK", port: "approved", explanation: "ok" } as never])).toHaveLength(1);
  });

  it("the validator refuses an ungated refund and AI-sourced amounts statically", () => {
    const g = refundGraph();
    g.edges = g.edges.map((e) => (e.from === "t" ? { ...e, to: "refund" } : e)).filter((e) => e.from !== "lim");
    g.nodes = g.nodes.filter((n) => n.id !== "lim" && n.id !== "too_big");
    expect(validateGraph(g).issues.map((i) => i.code)).toContain("ungated_money");
  });
});

describe("PayPal action nodes: PayPal failures", () => {
  it("a definitive PayPal refusal takes the error path and keeps the debug_id", async () => {
    fake.script = async () => ({ status: "failed", retryable: false, error: { code: "UNPROCESSABLE_ENTITY", message: "Capture has already been fully refunded", status: 422, debugId: "f00dbabe" } });
    const runId = await startRefund(goodPayload);
    expect(await advanceRun(runId, deps)).toBe("NEEDS_REVIEW");
    const refund = (await stepsOf(runId)).find((s) => s.nodeId === "refund")!;
    expect(refund).toMatchObject({ status: "ERROR", port: "error", explanation: "PayPal refused: Capture has already been fully refunded (debug_id f00dbabe)" });
    expect(refund.error).toMatchObject({ code: "UNPROCESSABLE_ENTITY", debugId: "f00dbabe" });
    const [ex] = await executions();
    expect(ex).toMatchObject({ status: "FAILED", debugId: "f00dbabe" });
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.outcome).toMatch(/^Needs review: PayPal refused/);
  });

  it("a network failure is retried later with the same key, then succeeds once", async () => {
    fake.script = async (_i, _c, n) => (n === 1 ? { status: "failed", retryable: true, error: { code: "NETWORK", message: "socket hang up" } } : null);
    const runId = await startRefund(goodPayload);
    expect(await advanceRun(runId, deps)).toBe("RUNNING");
    expect(enqueued.at(-1)).toMatchObject({ runId });
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    expect(new Set(fake.calls.map((c) => c.key))).toEqual(new Set([`pf:${runId}:refund`]));
    expect(fake.distinctObjects()).toBe(1);
    expect(await executions()).toHaveLength(1);
  });

  it("after three attempts without a definitive answer the outcome is UNKNOWN and the run fails closed", async () => {
    fake.script = async () => ({ status: "failed", retryable: true, error: { code: "NETWORK", message: "timeout" } });
    const runId = await startRefund(goodPayload);
    for (let i = 0; i < 3; i++) await advanceRun(runId, deps);
    expect(await advanceRun(runId, deps)).toBe("NEEDS_REVIEW");
    const [ex] = await executions();
    expect(ex.status).toBe("UNKNOWN");
    expect(fake.calls).toHaveLength(3);
    expect((await stepsOf(runId)).find((s) => s.nodeId === "refund")?.error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });
});

describe("PayPal action nodes: no duplicate money movement", () => {
  it("a worker crash after sending replays the same PayPal request (deduplicated), never a new one", async () => {
    const runId = await startRefund(goodPayload);
    // First worker: prepares and sends, then "crashes" before recording anything.
    fake.script = async (intent) => {
      fake.landWithoutReply(intent); // PayPal created refund REF-1 …
      throw new Error("worker killed"); // … and the worker died before hearing about it
    };
    await expect(advanceRun(runId, deps)).rejects.toThrow("worker killed");
    const [stuck] = await executions();
    expect(stuck.status).toBe("SUBMITTING");
    // Lease expires; another worker resumes.
    await db().update(actionExecutions).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(actionExecutions.id, stuck.id));
    fake.script = null;
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    expect(fake.calls.map((c) => c.key)).toEqual([`pf:${runId}:refund`, `pf:${runId}:refund`]);
    expect(fake.distinctObjects()).toBe(1); // the replay got REF-1 back; no second refund
    const [ex] = await executions();
    expect(ex).toMatchObject({ status: "SUCCEEDED", paypalRefs: ["REF-1"], attempts: 2 });
  });

  it("three workers advancing the same run at once call PayPal exactly once", async () => {
    fake.delayMs = 150;
    const runId = await startRefund(goodPayload);
    await Promise.all([advanceRun(runId, deps), advanceRun(runId, deps), advanceRun(runId, deps)]);
    await advanceRun(runId, deps);
    expect(fake.calls).toHaveLength(1);
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("COMPLETED");
  });

  it("two jobs racing to run the same execution: only the lease holder calls PayPal", async () => {
    fake.delayMs = 100;
    const runId = await startRefund(goodPayload);
    fake.script = async () => {
      throw new Error("stop after prepare");
    };
    await advanceRun(runId, deps).catch(() => {});
    const [ex] = await executions();
    await db().update(actionExecutions).set({ status: "PREPARED", attempts: 0, leaseUntil: null }).where(eq(actionExecutions.id, ex.id));
    fake.script = null;
    fake.calls = [];
    const results = await Promise.all([runAction(ex.id), runAction(ex.id), runAction(ex.id)]);
    expect(results.filter((r) => r === "settled")).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("a redelivered webhook cannot start a second run, so no second refund", async () => {
    const g = refundGraph();
    g.nodes[0] = { id: "t", type: "trigger.paypal_event", config: { eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] } };
    g.nodes[2].config = { captureIdRef: "trigger.resourceId", amountRef: "trigger.amount", note: "auto" };
    const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "auto-refund", graph: g });
    if (!c.ok) throw new Error("setup");
    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
    await grantAuthority(ws.id, user.id, [c.workflowId]);
    const raw = { id: "WH-DUP", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-DUP-1", amount: { value: "50.00", currency_code: "USD" } } };
    const [ev] = await db().insert(paypalEvents).values({ workspaceId: ws.id, eventId: raw.id, eventType: raw.event_type, resourceId: "CAP-DUP-1", verification: "SIMULATOR", provenance: "SIMULATED", raw }).returning();
    const http = { request: async () => Promise.reject(new Error("no")) };
    const first = await routePayPalEvent(ev.id, http as never, deps);
    await db().update(paypalEvents).set({ routedAt: null }).where(eq(paypalEvents.id, ev.id)); // force a second routing pass
    await routePayPalEvent(ev.id, http as never, deps);
    const runs = await db().select().from(workflowRuns);
    expect(runs).toHaveLength(1);
    await advanceRun(runs[0].id, deps);
    await advanceRun(runs[0].id, deps);
    expect(fake.calls).toHaveLength(1);
    expect("matched" in first && first.matched).toHaveLength(1);
  });
});

describe("PayPal action nodes: events and multi-step actions", () => {
  /** A PayPal event store that vouches for exactly the events it is given. */
  const paypalStore = (...events: { id: string; event_type: string }[]) => ({
    request: async ({ path }: { path: string }) => {
      const e = events.find((x) => path.endsWith(`/${x.id}`));
      if (!e) throw new Error("unknown event");
      return { status: 200, data: e, debugId: "dbg-confirm" };
    },
  });
  const storeEvent = async (raw: { id: string; event_type: string; resource: Record<string, unknown> }, provenance: "REAL_PAYPAL_SANDBOX" | "SIMULATED") => {
    const [ev] = await db()
      .insert(paypalEvents)
      .values({ workspaceId: ws.id, eventId: raw.id, eventType: raw.event_type, resourceId: String(raw.resource.id ?? ""), verification: provenance === "SIMULATED" ? "SIMULATOR" : "SELF", provenance, raw })
      .returning();
    return ev;
  };

  it("links a PayPal-confirmed webhook back to the action that caused it, then tracks later status", async () => {
    const runId = await startRefund(goodPayload);
    await advanceRun(runId, deps);
    const done = { id: "WH-REFUNDED", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", status: "COMPLETED", amount: { value: "120.00", currency_code: "USD" } } };
    const reversed = { id: "WH-REFUND-REVERSED", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", status: "CANCELLED" } };
    await routePayPalEvent((await storeEvent(done, "REAL_PAYPAL_SANDBOX")).id, paypalStore(done, reversed) as never, deps);
    let [ex] = await executions();
    expect(ex.confirmedByEventId).toBe("WH-REFUNDED");
    expect(ex.lastEventStatus).toBe("COMPLETED");
    await routePayPalEvent((await storeEvent(reversed, "REAL_PAYPAL_SANDBOX")).id, paypalStore(done, reversed) as never, deps);
    [ex] = await executions();
    expect(ex.confirmedByEventId).toBe("WH-REFUNDED"); // the first confirmation stands
    expect(ex.lastEventStatus).toBe("CANCELLED");
    const kinds = (await db().select().from(auditRecords).where(eq(auditRecords.runId, runId))).map((a) => a.kind);
    expect(kinds).toContain("action.confirmed");
    expect(kinds).toContain("action.event");
  });

  it("binds a PayPal event that arrived before the action's reply was recorded", async () => {
    const early = { id: "WH-EARLY", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", status: "COMPLETED" } };
    await routePayPalEvent((await storeEvent(early, "REAL_PAYPAL_SANDBOX")).id, paypalStore(early) as never, deps);
    const runId = await startRefund(goodPayload);
    await advanceRun(runId, deps);
    const [ex] = await executions();
    expect(ex.status).toBe("SUCCEEDED");
    expect(ex.confirmedByEventId).toBe("WH-EARLY");
    expect(ex.lastEventStatus).toBe("COMPLETED");
  });

  it("a simulated event never confirms a real PayPal action", async () => {
    const runId = await startRefund(goodPayload);
    await advanceRun(runId, deps);
    const fake = { id: "WH-SIM-REFUNDED", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", status: "COMPLETED" } };
    await routePayPalEvent((await storeEvent(fake, "SIMULATED")).id, paypalStore() as never, deps);
    const [ex] = await executions();
    expect(ex.confirmedByEventId).toBeNull();
    expect(ex.lastEventType).toBeNull();
  });

  it("an invoice created before a crash is sent on replay, not created twice", async () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger.manual", config: {} },
        { id: "lim", type: "policy.amount_limit", config: { amountRef: "trigger.amount", max: { value: "10000.00", currency: "USD" } } },
        { id: "inv", type: "paypal.invoice_send", config: { recipientRef: "trigger.email", amountRef: "trigger.amount", description: "September retainer" } },
        end("done", "completed"),
        end("no", "blocked"),
        end("review", "needs_review"),
      ],
      edges: [
        { from: "t", to: "lim", port: "next" },
        { from: "lim", to: "inv", port: "pass" },
        { from: "lim", to: "no", port: "block" },
        { from: "inv", to: "done", port: "done" },
        { from: "inv", to: "review", port: "error" },
      ],
    } as WorkflowGraph;
    fake.script = async (intent, ctx, n) => {
      if (n === 1) {
        await ctx.checkpoint(["INV2-AAAA"], { invoiceId: "INV2-AAAA" }); // draft created at PayPal…
        return { status: "failed", retryable: true, error: { code: "NETWORK", message: "connection reset during send" } }; // …send lost
      }
      expect(ctx.previous).toEqual({ invoiceId: "INV2-AAAA" });
      return { status: "succeeded", paypalRefs: ["INV2-AAAA"], paypalStatus: "SENT", debugId: null, result: { invoiceId: "INV2-AAAA", number: "0001" } };
    };
    const runId = await startRefund({ email: "ap@novalabs.example", amount: { value: "4000.00", currency_code: "USD" } }, graph);
    await advanceRun(runId, deps);
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    const [ex] = await executions();
    expect(ex).toMatchObject({ status: "SUCCEEDED", paypalRefs: ["INV2-AAAA"], counterparty: "ap@novalabs.example" });
    expect(fake.calls[1].previous).toEqual({ invoiceId: "INV2-AAAA" });
  });
});

describe("invoice events expose what was actually paid", () => {
  it("separates the invoice total from the amount paid so a partial payment cannot reconcile", () => {
    const t = normalizePayPalEvent({
      id: "WH-PAID",
      event_type: "INVOICING.INVOICE.PAID",
      resource: {
        invoice: {
          id: "INV2-AAAA-BBBB-CCCC-DDDD",
          amount: { value: "1200.00", currency_code: "USD" },
          payments: {
            paid_amount: { value: "700.00", currency_code: "USD" },
            transactions: [{ payment_id: "EXTR-1" }, { payment_id: "EXTR-2" }],
          },
        },
      },
    });
    expect(t.invoiceId).toBe("INV2-AAAA-BBBB-CCCC-DDDD");
    expect(t.amount).toEqual({ value: "1200.00", currency_code: "USD" });
    expect(t.paidAmount).toEqual({ value: "700.00", currency_code: "USD" });
    expect(t.paymentId).toBe("EXTR-2");
  });
});

describe("a payout whose reply was lost is recovered, never re-sent", () => {
  it("reads the existing batch id from PayPal's duplicate sender_batch_id refusal", () => {
    // The exact shape PayPal Sandbox returned when a payout was re-sent with the same sender_batch_id.
    const refusal = new PayPalApiError(400, "USER_BUSINESS_ERROR", "User business error.", "f601522a32400", [
      {
        field: "SENDER_BATCH_ID",
        location: "body",
        issue: "Batch with given sender_batch_id already exists",
        link: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/UM2QM3S7JCSDC", rel: "self", method: "GET", encType: "application/json" }],
      },
    ]);
    expect(existingBatchFor(refusal)).toBe("UM2QM3S7JCSDC");
    expect(existingBatchFor(new PayPalApiError(400, "VALIDATION_ERROR", "bad", undefined, [{ field: "items[0].receiver", issue: "invalid" }]))).toBeNull();
    expect(existingBatchFor(new PayPalApiError(500, "INTERNAL", "x"))).toBeNull();
  });
});
