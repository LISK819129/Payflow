import { and, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { livePayPalWrite } from "@/server/actions/capability";
import { runAction } from "@/server/actions/execute";
import { DirectPayPalGateway, setGatewayForTests } from "@/server/actions/paypal-gateway";
import type { ActionGateway, ActionIntent, ActionOutcome } from "@/server/actions/types";
import { MeteredProvider } from "@/server/ai/metered";
import type { AIResult } from "@/server/ai/types";
import { verifyChain } from "@/server/audit/audit";
import { closeDb, db } from "@/server/db/client";
import {
  actionExecutions,
  aiUsage,
  approvals,
  auditRecords,
  authorities,
  authorityDecisions,
  budgetReservations,
  paypalEvents,
  reconciliations,
  simulations,
  workflowRuns,
  workflows,
} from "@/server/db/schema";
import { MockAnalysisProvider } from "@/server/intelligence/mock";
import { setAnalysisProviderForTests } from "@/server/intelligence/runner";
import { PayPalHttp } from "@/server/paypal/http";
import * as operations from "@/server/paypal/operations";
import { SandboxWriteBlocked, withSandbox } from "@/server/runtime/mode";
import { observeEvent, simulate, WOULD_SEND_TEXT } from "@/server/simulation/run";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { advanceRun, decideApproval, startRun } from "@/server/workflow/runtime/engine";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { getRun } from "@/server/workflow/queries";
import { activateLatest, createWorkflow, saveDraft, setWorkflowState } from "@/server/workflow/service";
import { grantAuthority } from "./support/authority";
import { createUser, createWorkspace, resetTestDb } from "./support/db";

/** MOCK_TEST. A fake PayPal that records any call; the tests require it is never reached from a sandbox. */
class FakePayPal implements ActionGateway {
  readonly name = "fake-paypal";
  calls: ActionIntent[] = [];
  async execute(intent: ActionIntent): Promise<ActionOutcome> {
    this.calls.push(intent);
    return { status: "succeeded", paypalRefs: [`LIVE-${this.calls.length}`], paypalStatus: "PENDING", debugId: "dbg", result: { amount: intent.amount } };
  }
}

let fake: FakePayPal;
let ai: MockAnalysisProvider;
const deps: RuntimeDeps = { enqueueAdvance: async () => {}, now: () => new Date() };
let ws: { id: string };
let user: { id: string };

beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("PixelForge");
  user = await createUser(ws.id);
  fake = new FakePayPal();
  setGatewayForTests(fake);
  ai = new MockAnalysisProvider();
  setAnalysisProviderForTests(ai);
});
afterEach(() => {
  setGatewayForTests(null);
  setAnalysisProviderForTests(undefined);
});
afterAll(closeDb);

const ACME = "billing@acme-cloud.example";
const SCOPE = "Cloud infrastructure for PixelForge's own systems: compute (including GPU), storage, networking, managed databases.";
const end = (id: string, outcome: string) => ({ id, type: "control.terminal", config: { outcome, message: id } });
const invoice = (items: string, total: string, n = "INV-9001") => `From: Acme Cloud\nInvoice ${n}\nFor: ${items}\nTotal: $${total} USD\nDue date: 2026-11-01\nTerms: Net 30`;

/** The Cloud procurement shape: read invoice → purpose → behaviour → USD gate → payout. */
function cloudGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "bill", type: "trigger.manual", config: {} },
      { id: "extract", type: "ai.invoice_extract", config: { documentRef: "trigger.invoice", amountRef: "trigger.amount" } },
      { id: "purpose", type: "ai.purpose_classification", config: { textRefs: ["trigger.invoice"], amountRef: "trigger.amount", counterpartyRef: "trigger.supplierEmail", action: "paypal.payout" } },
      { id: "behavior", type: "ai.behavior_analysis", config: { paymentRef: "trigger.amount", counterpartyRef: "trigger.supplierEmail", descriptionRef: "trigger.invoice" } },
      { id: "usd", type: "policy.currency", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
      { id: "pay", type: "paypal.payout", label: "Pay the supplier", config: { receiverRef: "trigger.supplierEmail", amountRef: "trigger.amount", note: "x" } },
      end("paid", "completed"),
      end("not_usd", "needs_review"),
      end("refused", "needs_review"),
    ],
    edges: [
      { from: "bill", to: "extract", port: "next" },
      { from: "extract", to: "purpose", port: "done" },
      { from: "purpose", to: "behavior", port: "done" },
      { from: "behavior", to: "usd", port: "done" },
      { from: "usd", to: "pay", port: "pass" },
      { from: "usd", to: "not_usd", port: "block" },
      { from: "pay", to: "paid", port: "done" },
      { from: "pay", to: "refused", port: "error" },
    ],
  } as WorkflowGraph;
}

/** A gate → one action → done/error. */
const actionGraph = (action: { id: string; type: string; config: Record<string, unknown> }, trigger: Record<string, unknown> = { id: "t", type: "trigger.manual", config: {} }): WorkflowGraph =>
  ({
    schemaVersion: 1,
    nodes: [trigger, { id: "gate", type: "policy.frequency", config: { max: 100, period: "day", key: "x" } }, action, end("ok", "completed"), end("bad", "needs_review"), end("blocked", "blocked")],
    edges: [
      { from: trigger.id as string, to: "gate", port: "next" },
      { from: "gate", to: action.id, port: "pass" },
      { from: "gate", to: "blocked", port: "block" },
      { from: action.id, to: "ok", port: "done" },
      { from: action.id, to: "bad", port: "error" },
    ],
  }) as WorkflowGraph;

async function flow(graph: WorkflowGraph, activate = true) {
  const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: `wf-${Math.random()}`, graph });
  if (!c.ok) throw new Error(JSON.stringify(c));
  if (activate) {
    const a = await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
    if (!a.ok) throw new Error(JSON.stringify(a));
  }
  return c.workflowId;
}

const procurement = (wf: string, o: Parameters<typeof grantAuthority>[3] = {}) =>
  grantAuthority(ws.id, user.id, [wf], {
    name: "Cloud procurement",
    actions: ["paypal.payout", "paypal.refund", "paypal.order_capture", "paypal.invoice_send", "paypal.invoice_remind"],
    counterpartyRule: "allowlist",
    counterparties: [{ id: ACME, name: "Acme Cloud" }],
    currencies: ["USD"],
    perTransactionMax: "500",
    budgetAmount: "2000",
    budgetPeriod: "month",
    purposeScope: SCOPE,
    ...o,
  });

const test = (workflowId: string, payload: Record<string, unknown>, assumptions?: Record<string, "APPROVED" | "REJECTED">) =>
  simulate({ mode: "TEST", workspaceId: ws.id, workflowId, trigger: { kind: "manual", payload }, assumptions, userId: user.id });
const bill = (amount: string, items: string, supplier = ACME) => ({ supplierEmail: supplier, amount: { value: amount, currency_code: "USD" }, invoice: invoice(items, amount) });
const sim = async (id: string) => (await db().select().from(simulations).where(eq(simulations.id, id)))[0];

/** Every table a live financial action would touch. */
async function ledger() {
  const c = async (table: typeof actionExecutions | typeof approvals | typeof authorityDecisions | typeof budgetReservations | typeof reconciliations | typeof workflowRuns) =>
    (await db().select({ n: count() }).from(table))[0].n;
  const [a] = await db().select({ v: authorities.version }).from(authorities).limit(1);
  return {
    executions: await c(actionExecutions),
    approvals: await c(approvals),
    decisions: await c(authorityDecisions),
    reservations: await c(budgetReservations),
    reconciliations: await c(reconciliations),
    runs: await c(workflowRuns),
    authorityVersion: a?.v ?? null,
  };
}

describe("Test Run uses the real engine and changes nothing", () => {
  it("Test 1 · normal: WOULD ALLOW, the payout is shown but never sent, nothing recorded as live", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const before = await ledger();
    const r = await test(wf, bill("185.00", "GPU compute, 37 hours"));
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_ALLOW" });
    const s = await sim((r as { id: string }).id);
    expect(s).toMatchObject({ mode: "TEST", inputProvenance: "TEST_INPUT", externalActionsDisabled: true, versionNumber: 1 });
    expect(s.wouldAction).toMatchObject({ kind: "paypal.payout", amount: { value: "185.00", currency: "USD" }, counterparty: ACME });
    expect(s.headline).toMatch(/not sent in this test/);
    const steps = s.steps as { nodeId: string; explanation: string }[];
    expect(steps.find((x) => x.nodeId === (s.wouldAction as { nodeId: string }).nodeId)?.explanation).toBe(WOULD_SEND_TEXT);
    expect(steps.map((x) => x.explanation).join(" ")).not.toMatch(/sending to PayPal/);
    // The authority engine really ran (its decision is in the record) …
    expect(s.authorityDecision).toMatchObject({ decision: "ALLOW" });
    // … and none of it persisted.
    expect(await ledger()).toEqual(before);
    expect(fake.calls).toHaveLength(0);
  });

  it("Test 2 · semantic violation: deterministic checks pass, purpose OUTSIDE_SCOPE → WOULD REVIEW", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const before = await ledger();
    const r = await test(wf, bill("470.00", "10 x $47 digital gift cards"));
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_REVIEW" });
    const s = await sim((r as { id: string }).id);
    const evals = (s.authorityDecision as { evaluations: { check: string; result: string }[] }).evaluations;
    for (const k of ["counterparty", "currency", "per_transaction", "budget"]) expect(evals.find((e) => e.check === k)?.result).toBe("pass");
    expect(evals.find((e) => e.check === "purpose")?.result).toBe("review");
    expect(await ledger()).toEqual(before);
    expect(fake.calls).toHaveLength(0);
  });

  it("Test 3 · financial limit: over the per-transaction limit and over budget → review, real budget untouched", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf, { perTransactionMax: null, budgetAmount: "2000" });
    // Real spend of $1,670 already committed this month.
    const live = await startRun({ workflowId: wf, triggerKind: "manual", triggerRef: "live-1", triggerPayload: bill("1670.00", "GPU compute, annual reservation"), provenance: "USER_PROVIDED" }, deps);
    await advanceRun((live as { runId: string }).runId, deps);
    expect(fake.calls).toHaveLength(1);
    const before = await ledger();
    const resBefore = await db().select().from(budgetReservations);
    const r = await test(wf, bill("420.00", "GPU compute, 84 hours"));
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_REVIEW" });
    const s = await sim((r as { id: string }).id);
    expect((s.authorityDecision as { budget: { after: string }[] }).budget[0].after).toBe("2090.00");
    expect(s.budget).toEqual([expect.objectContaining({ committed: "1670.00", reserved: "0" })]);
    expect(await db().select().from(budgetReservations)).toEqual(resBefore);
    expect(await ledger()).toEqual(before);
    expect(fake.calls).toHaveLength(1);
  });

  it("Test 4 · unknown supplier → WOULD REVIEW", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const r = await test(wf, bill("120.00", "GPU compute", "invoices@unknown-vendor.example"));
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_REVIEW" });
    expect(fake.calls).toHaveLength(0);
  });

  it("Test 5 · approval exploration: 'Assume approved' follows the path inside the test only", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const first = (await test(wf, bill("470.00", "10 x $47 digital gift cards"))) as { id: string };
    const s1 = await sim(first.id);
    const reviewNode = (s1.approvals as { nodeId: string }[])[0].nodeId;
    const before = await ledger();
    const r = await simulate({ mode: "TEST", workspaceId: ws.id, workflowId: wf, trigger: { kind: "manual", payload: bill("470.00", "10 x $47 digital gift cards") }, assumptions: { [reviewNode]: "APPROVED" }, parentId: first.id, userId: user.id });
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_ALLOW" });
    const s = await sim((r as { id: string }).id);
    expect(s.headline).toMatch(/after the assumed approval — not sent in this test/);
    expect(s.approvals).toEqual([expect.objectContaining({ nodeId: reviewNode, status: "APPROVED", assumed: true })]);
    expect(await ledger()).toEqual(before);
    const kinds = (await db().select().from(auditRecords)).map((a) => a.kind);
    expect(kinds).not.toContain("approval.approved");
    expect(fake.calls).toHaveLength(0);
    const rejected = await simulate({ mode: "TEST", workspaceId: ws.id, workflowId: wf, trigger: { kind: "manual", payload: bill("470.00", "10 x $47 digital gift cards") }, assumptions: { [reviewNode]: "REJECTED" } });
    expect(rejected).toMatchObject({ ok: true, verdict: "WOULD_END" });
    // Nobody rejected anything: the record must not say a person did.
    const sr = await sim((rejected as { id: string }).id);
    expect(sr.headline).toMatch(/^After the assumed rejection \(only inside this test\)/);
    expect(sr.headline).not.toMatch(/by a person/);
  });
});

describe("Safety 1–10 · Test Run isolation", () => {
  it("1–4 · payout, refund, order capture and invoice: shown as 'would send', PayPal never contacted, nothing persisted", async () => {
    const graphs = [
      actionGraph({ id: "pay", type: "paypal.payout", config: { receiverRef: "trigger.to", amountRef: "trigger.amount", note: "x" } }),
      actionGraph({ id: "refund", type: "paypal.refund", config: { captureIdRef: "trigger.captureId", amountRef: "trigger.amount", note: "x" } }),
      actionGraph({ id: "capture", type: "paypal.order_capture", config: { orderIdRef: "trigger.orderId", amountRef: "trigger.amount" } }),
      actionGraph({ id: "invoice", type: "paypal.invoice_send", config: { recipientRef: "trigger.to", amountRef: "trigger.amount", description: "Design work" } }),
    ];
    const payload = { to: ACME, amount: { value: "50.00", currency_code: "USD" }, captureId: "CAP-1234567", orderId: "ORDER-1234567" };
    for (const g of graphs) {
      const wf = await flow(g);
      await procurement(wf, { counterpartyRule: "any", purposeScope: null });
      const before = await ledger();
      const r = await test(wf, payload);
      expect(r).toMatchObject({ ok: true, verdict: "WOULD_ALLOW" });
      expect(await ledger()).toEqual(before);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("5 · no real budget reserved (workflow budget node and authority budget)", async () => {
    const g = actionGraph({ id: "pay", type: "paypal.payout", config: { receiverRef: "trigger.to", amountRef: "trigger.amount", note: "x" } });
    g.nodes[1] = { id: "gate", type: "policy.budget", config: { amountRef: "trigger.amount", budget: { value: "1000", currency: "USD" }, period: "month", budgetKey: "cloud" } };
    const wf = await flow(g);
    await procurement(wf, { counterpartyRule: "any", purposeScope: null });
    await test(wf, { to: ACME, amount: { value: "400.00", currency_code: "USD" } });
    await test(wf, { to: ACME, amount: { value: "400.00", currency_code: "USD" } });
    await test(wf, { to: ACME, amount: { value: "400.00", currency_code: "USD" } });
    expect(await db().select().from(budgetReservations)).toEqual([]);
    // Three tests of $400 against $1,000 all pass: none of them consumed the budget.
    expect((await db().select().from(simulations)).map((s) => s.verdict)).toEqual(["WOULD_ALLOW", "WOULD_ALLOW", "WOULD_ALLOW"]);
  });

  it("6 · ledger untouched by a reconciliation test", async () => {
    const wf = await flow(actionGraph({ id: "rec", type: "ledger.reconcile", config: { paymentRef: "trigger.amount", invoiceIdRef: "trigger.invoiceId" } }));
    const r = await test(wf, { amount: { value: "100.00", currency_code: "USD" }, invoiceId: "INV2-AAAA-BBBB-CCCC-DDDD" });
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_ALLOW" });
    expect(await db().select().from(reconciliations)).toEqual([]);
  });

  it("7–9 · no executable approval; a test cannot be resumed, approved or executed by its id", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const r = (await test(wf, bill("470.00", "10 x $47 digital gift cards"))) as { id: string };
    expect(await db().select().from(approvals)).toEqual([]);
    // The test id is not a run, an approval or an execution anywhere live code looks.
    expect(await getRun(ws.id, r.id)).toBeNull();
    await expect(advanceRun(r.id, deps)).rejects.toThrow(/not found/);
    expect(await decideApproval({ approvalId: r.id, workspaceId: ws.id, userId: user.id, decision: "APPROVED" }, deps)).toMatchObject({ error: "Approval not found" });
    expect(await runAction(r.id)).toBe("busy");
    expect(fake.calls).toHaveLength(0);
  });

  it("10 · 'Assume approved' never becomes a real approval or a live action", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const s1 = await sim(((await test(wf, bill("470.00", "10 x $47 digital gift cards"))) as { id: string }).id);
    const node = (s1.approvals as { nodeId: string }[])[0].nodeId;
    await test(wf, bill("470.00", "10 x $47 digital gift cards"), { [node]: "APPROVED" });
    expect(await db().select().from(approvals)).toEqual([]);
    expect(await db().select().from(actionExecutions)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

/** A real-provenance event, as webhook ingest stores it after PayPal confirmed it. */
async function realEvent(id: string, type: string, resource: Record<string, unknown>) {
  const raw = { id, event_type: type, resource };
  const [ev] = await db()
    .insert(paypalEvents)
    .values({ workspaceId: ws.id, eventId: id, eventType: type, resourceId: String(resource.id ?? ""), verification: "SELF", provenance: "REAL_PAYPAL_SANDBOX", raw, routedAt: new Date() })
    .returning();
  return ev;
}

const eventGraph = (action: { id: string; type: string; config: Record<string, unknown> }, types = ["PAYMENT.CAPTURE.COMPLETED"]) =>
  actionGraph(action, { id: "t", type: "trigger.paypal_event", config: { eventTypes: types } });

async function observingDraft(graph: WorkflowGraph) {
  const wf = await flow(graph, false);
  await db().update(workflows).set({ observing: true, observingSince: new Date() }).where(eq(workflows.id, wf));
  return wf;
}

describe("Safety 11–15 · Observe Mode isolation", () => {
  it("11–14 · a real event observed by a refund draft: PayPal untouched, no budget, ledger, approval or execution", async () => {
    const wf = await observingDraft(eventGraph({ id: "refund", type: "paypal.refund", config: { captureIdRef: "trigger.resourceId", amountRef: "trigger.amount", note: "auto" } }));
    await procurement(wf, { counterpartyRule: "any", purposeScope: null });
    const before = await ledger();
    const ev = await realEvent("WH-REAL-1", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-9876543", amount: { value: "80.00", currency_code: "USD" } });
    const r = await observeEvent(ev.id);
    expect(r).toEqual([expect.objectContaining({ ok: true, verdict: "WOULD_ALLOW" })]);
    const [s] = await db().select().from(simulations);
    expect(s).toMatchObject({ mode: "OBSERVE", inputProvenance: "REAL_PAYPAL_EVENT_OBSERVED", paypalEventId: "WH-REAL-1", externalActionsDisabled: true });
    expect(await ledger()).toEqual(before);
    expect(fake.calls).toHaveLength(0);
    // The record says where its input came from — never "started manually" for a real event.
    expect((s.steps as { nodeType: string; explanation: string }[])[0].explanation).toMatch(/^Real PayPal event PAYMENT\.CAPTURE\.COMPLETED .*Observe Mode/);
  });

  it("12–14 · observing a draft with a budget node and an approval creates neither", async () => {
    const g = eventGraph({ id: "pay", type: "paypal.payout", config: { receiverRef: "trigger.payer.email", amountRef: "trigger.amount", note: "x" } });
    g.nodes[1] = { id: "gate", type: "policy.budget", config: { amountRef: "trigger.amount", budget: { value: "50", currency: "USD" }, period: "month", budgetKey: "obs" } };
    const wf = await observingDraft(g);
    await procurement(wf, { counterpartyRule: "any", purposeScope: null });
    const ev = await realEvent("WH-REAL-2", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-2", amount: { value: "40.00", currency_code: "USD" }, payer: { email_address: "buyer@example.com" } });
    await observeEvent(ev.id);
    expect(await db().select().from(budgetReservations)).toEqual([]);
    expect(await db().select().from(approvals)).toEqual([]);
  });

  it("15 · observation cannot start or advance any live workflow", async () => {
    const live = await flow(eventGraph({ id: "refund", type: "paypal.refund", config: { captureIdRef: "trigger.resourceId", amountRef: "trigger.amount", note: "x" } }));
    await procurement(live, { counterpartyRule: "any", purposeScope: null });
    const draft = await observingDraft(eventGraph({ id: "refund", type: "paypal.refund", config: { captureIdRef: "trigger.resourceId", amountRef: "trigger.amount", note: "x" } }));
    await procurement(draft, { name: "draft", counterpartyRule: "any", purposeScope: null });
    const ev = await realEvent("WH-REAL-3", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-3", amount: { value: "10.00", currency_code: "USD" } });
    const runsBefore = await db().select().from(workflowRuns);
    await observeEvent(ev.id);
    expect(await db().select().from(workflowRuns)).toEqual(runsBefore);
    expect(fake.calls).toHaveLength(0);
    // Simulator events are never observed: only PayPal-confirmed real events.
    await db().insert(paypalEvents).values({ workspaceId: ws.id, eventId: "WH-SIM", eventType: "PAYMENT.CAPTURE.COMPLETED", verification: "SIMULATOR", provenance: "SIMULATED", raw: { id: "WH-SIM", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }, routedAt: new Date() });
    const [sim2] = await db().select().from(paypalEvents).where(eq(paypalEvents.eventId, "WH-SIM"));
    expect(await observeEvent(sim2.id)).toEqual([]);
  });
});

describe("Safety 16–20 · concurrency, versions, AI failure, forgery, defence in depth", () => {
  it("16 · a test and a live payment at the same moment: the live one reserves and pays once, the test reserves nothing", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf, { purposeScope: null });
    const live = (await startRun({ workflowId: wf, triggerKind: "manual", triggerRef: "live-2", triggerPayload: bill("300.00", "GPU compute"), provenance: "USER_PROVIDED" }, deps)) as { runId: string };
    const [liveStatus, t] = await Promise.all([advanceRun(live.runId, deps), test(wf, bill("300.00", "GPU compute, other"))]);
    expect(liveStatus).toBe("COMPLETED");
    expect(t).toMatchObject({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(await db().select().from(budgetReservations)).toEqual([expect.objectContaining({ amount: "300.00", status: "COMMITTED", runId: live.runId })]);
  });

  it("17 · a draft edited while observing: old observations keep the exact graph they used", async () => {
    const g = eventGraph({ id: "refund", type: "paypal.refund", config: { captureIdRef: "trigger.resourceId", amountRef: "trigger.amount", note: "x" } });
    const wf = await observingDraft(g);
    await procurement(wf, { counterpartyRule: "any", purposeScope: null });
    await observeEvent((await realEvent("WH-A", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-A", amount: { value: "10.00", currency_code: "USD" } })).id);
    const g2 = structuredClone(g);
    g2.nodes[1].config = { max: 1, period: "day", key: "edited" };
    expect((await saveDraft({ workspaceId: ws.id, userId: user.id, workflowId: wf, graph: g2 })).ok).toBe(true);
    await observeEvent((await realEvent("WH-B", "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-B", amount: { value: "10.00", currency_code: "USD" } })).id);
    const [a, b] = await db().select().from(simulations).orderBy(simulations.createdAt);
    expect(a.graphHash).not.toBe(b.graphHash);
    expect((a.graph as WorkflowGraph).nodes[1].config).toMatchObject({ max: 100, key: "x" });
    expect((b.graph as WorkflowGraph).nodes[1].config).toMatchObject({ max: 1, key: "edited" });
  });

  it("18 · AI failure during a test fails safe: UNCERTAIN → review, never permission", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    ai.script = async () => ({ ok: false, code: "PROVIDER_ERROR", message: "timeout", model: "mock-analyst-1" }) as AIResult<unknown>;
    const r = await test(wf, bill("120.00", "GPU compute"));
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_REVIEW" });
    expect(fake.calls).toHaveLength(0);
  });

  it("19 · forged requests to run a simulation as LIVE are refused", async () => {
    const wf = await flow(cloudGraph());
    expect(await simulate({ mode: "LIVE" as never, workspaceId: ws.id, workflowId: wf, trigger: { kind: "manual", payload: {} } })).toMatchObject({ ok: false });
    expect(() => withSandbox("LIVE" as never, "x", async () => 1)).toThrow(/Unknown sandbox mode/);
    expect(await db().select().from(simulations)).toEqual([]);
  });

  it("20 · even code that deliberately tries to pay from inside a sandbox cannot reach PayPal", async () => {
    // A real prepared execution (as live code would have left it).
    const wf = await flow(actionGraph({ id: "pay", type: "paypal.payout", config: { receiverRef: "trigger.to", amountRef: "trigger.amount", note: "x" } }));
    await procurement(wf, { counterpartyRule: "any", purposeScope: null });
    setGatewayForTests(null); // the REAL DirectPayPalGateway, not the fake
    let fetches = 0;
    const http = new PayPalHttp(() => "https://api-m.sandbox.paypal.com", { get: async () => ({ token: "t", expiresAt: Date.now() + 1e6 }) } as never, (async () => {
      fetches++;
      return new Response("{}", { status: 200 });
    }) as never);
    await withSandbox("TEST", "attack", async () => {
      // No capability can be obtained …
      expect(() => livePayPalWrite()).toThrow(SandboxWriteBlocked);
      // … the runner refuses to run without one, and refuses an imitation …
      await expect(runAction("00000000-0000-0000-0000-000000000000")).rejects.toThrow(SandboxWriteBlocked);
      await expect(runAction("00000000-0000-0000-0000-000000000000", { gatewayFor: () => fake } as never)).rejects.toThrow(/genuine/);
      // … the real gateway refuses …
      await expect(new DirectPayPalGateway().execute({ kind: "paypal.payout" } as ActionIntent, {} as never)).rejects.toThrow(SandboxWriteBlocked);
      // … the SDK write operations refuse …
      await expect(operations.refundCapture({ captureId: "C", amount: { value: "1.00", currency: "USD" }, note: "", requestId: "r" })).rejects.toThrow(SandboxWriteBlocked);
      await expect(operations.captureOrder({ orderId: "O", requestId: "r" })).rejects.toThrow(SandboxWriteBlocked);
      // … and the HTTP client refuses any write before a single byte leaves, while reads still work.
      await expect(http.request({ method: "POST", path: "/v1/payments/payouts", requestId: "r", body: {} })).rejects.toThrow(SandboxWriteBlocked);
      await expect(http.request({ method: "PATCH", path: "/v1/x" })).rejects.toThrow(SandboxWriteBlocked);
      expect(fetches).toBe(0);
      await http.request({ method: "GET", path: "/v1/notifications/webhooks" });
      expect(fetches).toBe(1);
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("records, provenance, cache", () => {
  it("records the versions evaluated, the snapshot time and the input provenance; audit says no money moved", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const r = (await test(wf, bill("185.00", "GPU compute"))) as { id: string };
    const s = await sim(r.id);
    expect(s.authorities).toEqual([expect.objectContaining({ name: "Cloud procurement", version: 1 })]);
    expect(s.evaluatedAt).toBeInstanceOf(Date);
    expect(s.trigger).toMatchObject({ kind: "manual" });
    const [rec] = await db().select().from(auditRecords).where(and(eq(auditRecords.kind, "simulation.test_run")));
    expect(rec.summary).toMatch(/^TEST RUN — no money moved, PayPal not contacted/);
    expect((await verifyChain(ws.id)).ok).toBe(true);
  });

  it("reuses cached analyses: a second identical test makes no model call", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    await test(wf, bill("185.00", "GPU compute"));
    const n = ai.calls.length;
    expect(n).toBeGreaterThan(0);
    // Computed for the first test: not a cache hit, and never described as one.
    const fresh = await db().select().from(simulations).orderBy(simulations.createdAt);
    expect((fresh[0].ai as { source: string; cached: boolean }[]).filter((x) => x.source === "ai").every((x) => !x.cached)).toBe(true);
    expect((fresh[0].steps as { explanation: string }[]).map((x) => x.explanation).join(" ")).not.toMatch(/reused from cache/);
    const r = (await test(wf, bill("185.00", "GPU compute"))) as { id: string };
    expect(ai.calls.length).toBe(n);
    expect(((await sim(r.id)).ai as { label: string }[]).every((x) => ["MOCK_TEST", "CALCULATED_BY_PAYFLOW"].includes(x.label))).toBe(true);
    expect(((await sim(r.id)).ai as { source: string; cached: boolean }[]).filter((x) => x.source === "ai").every((x) => x.cached)).toBe(true);
  });

  it("a $0 phase cap refuses the model call before it is made: AI_UNAVAILABLE, review, nothing spent", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const model = { calls: 0 };
    const priced = Object.assign(new MockAnalysisProvider(), { name: "openai", model: "gpt-5.4-mini" });
    priced.script = async () => {
      model.calls++;
      return { ok: false, code: "PROVIDER_ERROR", message: "must not be reached", model: "gpt-5.4-mini" } as AIResult<unknown>;
    };
    setAnalysisProviderForTests(new MeteredProvider(priced, { workspaceId: ws.id }, { inputTokens: 6000, outputTokens: 3000 }));
    const saved = { cap: process.env.AI_PHASE_CAP_USD, since: process.env.AI_PHASE_SINCE };
    process.env.AI_PHASE_CAP_USD = "0";
    process.env.AI_PHASE_SINCE = new Date(Date.now() - 60_000).toISOString();
    try {
      const r = (await test(wf, bill("185.00", "GPU compute"))) as { id: string; verdict: string };
      expect(r.verdict).toBe("WOULD_REVIEW");
      expect(model.calls).toBe(0);
      const labels = ((await sim(r.id)).ai as { source: string; label: string }[]).filter((x) => x.source === "ai").map((x) => x.label);
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((l) => l === "AI_UNAVAILABLE")).toBe(true);
      expect((await db().select({ n: count() }).from(aiUsage))[0].n).toBe(0);
    } finally {
      process.env.AI_PHASE_CAP_USD = saved.cap;
      process.env.AI_PHASE_SINCE = saved.since;
      if (saved.cap === undefined) delete process.env.AI_PHASE_CAP_USD;
      if (saved.since === undefined) delete process.env.AI_PHASE_SINCE;
    }
  });

  it("a test's trigger step says it is test input, not a PayPal event or a manual run", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    const r = (await test(wf, bill("185.00", "GPU compute"))) as { id: string };
    const [first] = (await sim(r.id)).steps as { explanation: string }[];
    expect(first.explanation).toBe("Test input provided by a person — not a PayPal event");
  });

  it("works on a paused workflow too, and says live runs would be suspended", async () => {
    const wf = await flow(cloudGraph());
    await procurement(wf);
    await setWorkflowState({ workspaceId: ws.id, userId: user.id, workflowId: wf, to: "PAUSED" });
    const r = await test(wf, bill("185.00", "GPU compute"));
    expect(r).toMatchObject({ ok: true, verdict: "WOULD_SUSPEND" });
  });
});
