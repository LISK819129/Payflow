import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGatewayForTests } from "@/server/actions/paypal-gateway";
import type { ActionGateway, ActionIntent, ActionOutcome, GatewayContext } from "@/server/actions/types";
import { setAfterUsageReadForTests } from "@/server/authority/internal";
import { setLedgerFaultForTests } from "@/server/authority/ledger";
import { setAuthorityStatus, updateAuthority } from "@/server/authority/service";
import { verifyChain } from "@/server/audit/audit";
import { closeDb, db } from "@/server/db/client";
import { actionExecutions, approvals, authorityDecisions, budgetReservations, runSteps, workflowRuns } from "@/server/db/schema";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { advanceRun, decideApproval, startRun } from "@/server/workflow/runtime/engine";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { activateLatest, createWorkflow, saveDraft, setWorkflowState } from "@/server/workflow/service";
import { grantAuthority } from "./support/authority";
import { createUser, createWorkspace, resetTestDb } from "./support/db";

/** PayPal stand-in (MOCK_TEST): same idempotency key → same object, like PayPal-Request-Id. */
class FakePayPal implements ActionGateway {
  readonly name = "fake-paypal";
  calls: ActionIntent[] = [];
  private byKey = new Map<string, ActionOutcome>();
  script: ((intent: ActionIntent, ctx: GatewayContext, n: number) => Promise<ActionOutcome | null>) | null = null;
  delayMs = 0;
  async execute(intent: ActionIntent, ctx: GatewayContext): Promise<ActionOutcome> {
    this.calls.push(intent);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const scripted = this.script ? await this.script(intent, ctx, this.calls.length) : null;
    if (scripted) return scripted;
    return this.land(intent);
  }
  land(intent: ActionIntent) {
    const seen = this.byKey.get(intent.idempotencyKey);
    if (seen) return seen;
    const id = `BATCH-${this.byKey.size + 1}`;
    const out: ActionOutcome = { status: "succeeded", paypalRefs: [id], paypalStatus: "PENDING", debugId: "dbg-ok", result: { payoutBatchId: id, amount: intent.amount } };
    this.byKey.set(intent.idempotencyKey, out);
    return out;
  }
  objects() {
    return this.byKey.size;
  }
}

let fake: FakePayPal;
let clock = new Date();
const deps: RuntimeDeps = { enqueueAdvance: async () => {}, now: () => clock };
let ws: { id: string };
let user: { id: string };

beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("PixelForge");
  user = await createUser(ws.id);
  fake = new FakePayPal();
  setGatewayForTests(fake);
  clock = new Date();
});
afterEach(() => {
  setGatewayForTests(null);
  setLedgerFaultForTests(null);
  setAfterUsageReadForTests(null);
});
afterAll(closeDb);

const ACME = "billing@acme-cloud.example";
const AWS = "aws-billing@amazon.example";
const usd = (value: string) => ({ value, currency_code: "USD" });
const end = (id: string, outcome: string) => ({ id, type: "control.terminal", config: { outcome, message: id } });

/** Manual bill → frequency gate (a workflow-level policy that passes) → payout. Authority does the rest. */
function payoutGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "bill", type: "trigger.manual", config: {} },
      { id: "gate", type: "policy.frequency", label: "At most 100 bills a day", config: { max: 100, period: "day", key: "bills" } },
      { id: "pay", type: "paypal.payout", label: "Pay the supplier", config: { receiverRef: "trigger.supplier", amountRef: "trigger.amount", note: "Payment" } },
      end("paid", "completed"),
      end("too_many", "blocked"),
      end("refused", "needs_review"),
    ],
    edges: [
      { from: "bill", to: "gate", port: "next" },
      { from: "gate", to: "pay", port: "pass" },
      { from: "gate", to: "too_many", port: "block" },
      { from: "pay", to: "paid", port: "done" },
      { from: "pay", to: "refused", port: "error" },
    ],
  } as WorkflowGraph;
}

async function flow(graph = payoutGraph()) {
  const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: `procurement-${Math.random()}`, graph });
  if (!c.ok) throw new Error(JSON.stringify(c));
  const a = await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
  if (!a.ok) throw new Error(JSON.stringify(a));
  return c.workflowId;
}

/** “Cloud procurement”: payouts to Acme Cloud / AWS, USD, $1,000 a month (per-transaction limit off unless given). */
const procurement = (workflowId: string, overrides: Parameters<typeof grantAuthority>[3] = {}) =>
  grantAuthority(ws.id, user.id, [workflowId], {
    name: "Cloud procurement",
    actions: ["paypal.payout"],
    counterpartyRule: "allowlist",
    counterparties: [
      { id: ACME, name: "Acme Cloud" },
      { id: AWS, name: "AWS" },
    ],
    currencies: ["USD"],
    budgetAmount: "1000.00",
    budgetPeriod: "month",
    ...overrides,
  });

async function pay(workflowId: string, amount: { value: string; currency_code: string }, supplier = ACME) {
  const r = await startRun({ workflowId, triggerKind: "manual", triggerRef: `m-${Math.random()}`, triggerPayload: { supplier, amount }, provenance: "USER_PROVIDED" }, deps);
  return (r as { runId: string }).runId;
}
const run = async (id: string) => (await db().select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
const decisions = (runId: string) => db().select().from(authorityDecisions).where(eq(authorityDecisions.runId, runId));
const reservations = (authorityId?: string) => db().select().from(budgetReservations).where(authorityId ? eq(budgetReservations.authorityId, authorityId) : undefined);
const approvalFor = async (runId: string) => (await db().select().from(approvals).where(eq(approvals.runId, runId)))[0];
const approve = (approvalId: string, decision: "APPROVED" | "REJECTED" = "APPROVED") => decideApproval({ approvalId, workspaceId: ws.id, userId: user.id, decision, note: "checked" }, deps);
const sum = (rows: { amount: string | null; status: string }[], statuses: string[]) =>
  rows.filter((r) => statuses.includes(r.status)).reduce((t, r) => t + Math.round(Number(r.amount ?? 0) * 100), 0) / 100;

describe("1–2 · budget: allow within, review beyond", () => {
  it("$500 under a $1,000 monthly budget is allowed, reserved, paid once and committed", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    const id = await pay(wf, usd("500.00"));
    expect(await advanceRun(id, deps)).toBe("COMPLETED");
    expect(fake.calls).toHaveLength(1);
    const [d] = await decisions(id);
    expect(d).toMatchObject({ decision: "ALLOW", outcome: "ALLOW", authorityId: auth });
    expect(d.budget).toEqual([expect.objectContaining({ limit: "1000.00", committed: "0", reserved: "0", request: "500.00", after: "500.00" })]);
    const rs = await reservations(auth);
    expect(rs).toEqual([expect.objectContaining({ amount: "500.00", status: "COMMITTED", override: false })]);
    const [ex] = await db().select().from(actionExecutions);
    expect(ex.decisionId).toBe(d.id);
    expect(ex.authorityId).toBe(auth);
  });

  it("another $600 would exceed the $1,000 budget → review; PayPal is not contacted", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    await advanceRun(await pay(wf, usd("500.00")), deps);
    const id = await pay(wf, usd("600.00"));
    expect(await advanceRun(id, deps)).toBe("WAITING_APPROVAL");
    expect(fake.calls).toHaveLength(1);
    const [d] = await decisions(id);
    expect(d.decision).toBe("REVIEW");
    expect(d.budget).toEqual([expect.objectContaining({ committed: "500.00", request: "600.00", after: "1100.00" })]);
    expect((d.evaluations as { check: string; result: string }[]).find((e) => e.check === "budget")?.result).toBe("review");
    expect(await reservations(auth)).toHaveLength(1); // nothing reserved for the request under review
    const a = await approvalFor(id);
    expect(a.reason).toMatch(/over the \$1,000\.00 budget/);
    expect((a.summary as { kind: string }).kind).toBe("authority_review");
  });
});

describe("3 · concurrency: the last of a budget can only be granted once", () => {
  it("two simultaneous $600 requests against $1,000: never both authorized", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    // Hold each request between reading the budget and reserving: without the lock both would see $0 used.
    setAfterUsageReadForTests(() => new Promise((r) => setTimeout(r, 150)));
    const [a, b] = [await pay(wf, usd("600.00")), await pay(wf, usd("600.00"))];
    const statuses = await Promise.all([advanceRun(a, deps), advanceRun(b, deps)]);
    expect(statuses.sort()).toEqual(["COMPLETED", "WAITING_APPROVAL"]);
    expect(fake.calls).toHaveLength(1);
    const rs = await reservations(auth);
    expect(sum(rs, ["RESERVED", "COMMITTED"])).toBe(600);
  });

  it("five simultaneous $300 requests against $1,000: exactly three pass", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    fake.delayMs = 20;
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await pay(wf, usd("300.00")));
    const statuses = await Promise.all(ids.map((id) => advanceRun(id, deps)));
    expect(statuses.filter((s) => s === "COMPLETED")).toHaveLength(3);
    expect(statuses.filter((s) => s === "WAITING_APPROVAL")).toHaveLength(2);
    expect(fake.calls).toHaveLength(3);
    expect(sum(await reservations(auth), ["COMMITTED"])).toBe(900);
  });
});

describe("4–6 · counterparty, currency, validity", () => {
  it("allowed supplier passes; unknown supplier goes to review; a denied one is blocked", async () => {
    const wf = await flow();
    await procurement(wf, { deniedCounterparties: [{ id: "payments@blocked-vendor.example", name: "Blocked Vendor" }] });
    expect(await advanceRun(await pay(wf, usd("100.00"), AWS), deps)).toBe("COMPLETED");
    const unknown = await pay(wf, usd("100.00"), "invoices@unknown-vendor.example");
    expect(await advanceRun(unknown, deps)).toBe("WAITING_APPROVAL");
    expect((await decisions(unknown))[0].evaluations).toContainEqual(expect.objectContaining({ check: "counterparty", result: "review" }));
    const denied = await pay(wf, usd("100.00"), "payments@blocked-vendor.example");
    expect(await advanceRun(denied, deps)).toBe("BLOCKED");
    expect((await run(denied)).outcome).toMatch(/Blocked Vendor is on the deny list.*PayPal was not contacted/);
    expect(fake.calls).toHaveLength(1);
  });

  it("USD is allowed; EUR is denied (and never compared to a USD budget)", async () => {
    const wf = await flow();
    await procurement(wf);
    expect(await advanceRun(await pay(wf, usd("100.00")), deps)).toBe("COMPLETED");
    const eur = await pay(wf, { value: "100.00", currency_code: "EUR" });
    expect(await advanceRun(eur, deps)).toBe("BLOCKED");
    const [d] = await decisions(eur);
    expect(d.decision).toBe("DENY");
    expect(d.evaluations).toContainEqual(expect.objectContaining({ check: "currency", result: "deny" }));
    expect(fake.calls).toHaveLength(1);
  });

  it("an expired authority permits nothing; neither does one not yet valid", async () => {
    const wf = await flow();
    await procurement(wf, { expiresAt: new Date(clock.getTime() - 86_400_000) });
    const id = await pay(wf, usd("10.00"));
    expect(await advanceRun(id, deps)).toBe("BLOCKED");
    expect((await run(id)).outcome).toMatch(/Expired on/);
    const wf2 = await flow();
    await procurement(wf2, { validFrom: new Date(clock.getTime() + 86_400_000) });
    expect(await advanceRun(await pay(wf2, usd("10.00")), deps)).toBe("BLOCKED");
    expect(fake.calls).toHaveLength(0);
  });

  it("a per-transaction limit sends larger payments to review", async () => {
    const wf = await flow();
    await procurement(wf, { perTransactionMax: "500", budgetAmount: "2000", budgetPeriod: "month" });
    expect(await advanceRun(await pay(wf, usd("500.00")), deps)).toBe("COMPLETED");
    const big = await pay(wf, usd("500.01"));
    expect(await advanceRun(big, deps)).toBe("WAITING_APPROVAL");
    expect((await approvalFor(big)).reason).toMatch(/exceeds the \$500\.00 per-transaction limit/);
  });

  it("no authority covering the action → a person decides; overlapping authorities must all allow", async () => {
    const wf = await flow();
    const none = await pay(wf, usd("50.00"));
    expect(await advanceRun(none, deps)).toBe("WAITING_APPROVAL");
    expect((await decisions(none))[0].evaluations).toContainEqual(expect.objectContaining({ check: "authority", result: "review" }));
    const wf2 = await flow();
    await procurement(wf2);
    await grantAuthority(ws.id, user.id, [wf2], { name: "Treasury freeze", actions: ["paypal.payout"], currencies: ["GBP"] });
    const both = await pay(wf2, usd("50.00"));
    expect(await advanceRun(both, deps)).toBe("BLOCKED"); // the second authority does not permit USD
    expect(fake.calls).toHaveLength(0);
  });

  it("a frequency limit on the authority sends the next action to review", async () => {
    const wf = await flow();
    await procurement(wf, { budgetAmount: null, budgetPeriod: null, maxCount: 2, countPeriod: "day" });
    expect(await advanceRun(await pay(wf, usd("10.00")), deps)).toBe("COMPLETED");
    expect(await advanceRun(await pay(wf, usd("10.00")), deps)).toBe("COMPLETED");
    const third = await pay(wf, usd("10.00"));
    expect(await advanceRun(third, deps)).toBe("WAITING_APPROVAL");
    expect((await approvalFor(third)).reason).toMatch(/action 3 this day; the limit is 2/);
  });

  it("budget state that cannot be read fails closed to review", async () => {
    const wf = await flow();
    await procurement(wf);
    setLedgerFaultForTests("throw");
    const id = await pay(wf, usd("10.00"));
    // The workflow-level frequency gate cannot read its counter either → blocked before the authority is even asked.
    expect(await advanceRun(id, deps)).toBe("BLOCKED");
    expect(fake.calls).toHaveLength(0);
    setLedgerFaultForTests(null);
  });
});

describe("7–8 · human approval: exactly one PayPal action", () => {
  it("review → approve once → resume → exactly one payout, counted against the budget", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    const id = await pay(wf, usd("1200.00"));
    expect(await advanceRun(id, deps)).toBe("WAITING_APPROVAL");
    const a = await approvalFor(id);
    expect((await approve(a.id)).error).toBeUndefined();
    expect(await advanceRun(id, deps)).toBe("COMPLETED");
    expect(await advanceRun(id, deps)).toBe("COMPLETED");
    expect(fake.calls).toHaveLength(1);
    const ds = await decisions(id);
    expect(ds.map((d) => d.outcome)).toEqual(["REVIEW", "ALLOW_AFTER_HUMAN_APPROVAL"]);
    expect(ds[1].approvalId).toBe(a.id);
    expect(await reservations(auth)).toEqual([expect.objectContaining({ amount: "1200.00", status: "COMMITTED", override: true, approvalId: a.id })]);
    expect((await run(id)).outcome).toMatch(/Completed after approval at the authority review for “Pay the supplier”/);
  });

  it("two simultaneous Approve clicks: one decision, one PayPal action", async () => {
    const wf = await flow();
    await procurement(wf);
    const id = await pay(wf, usd("1500.00"));
    await advanceRun(id, deps);
    const a = await approvalFor(id);
    const results = await Promise.all([approve(a.id), approve(a.id)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error).toBe("Already approved");
    await Promise.all([advanceRun(id, deps), advanceRun(id, deps)]);
    expect(fake.calls).toHaveLength(1);
  });

  it("Approve and Reject at the same moment: exactly one wins", async () => {
    const wf = await flow();
    await procurement(wf);
    const id = await pay(wf, usd("1500.00"));
    await advanceRun(id, deps);
    const a = await approvalFor(id);
    const [x, y] = await Promise.all([approve(a.id, "APPROVED"), approve(a.id, "REJECTED")]);
    expect([x.error, y.error].filter(Boolean)).toHaveLength(1);
    const final = await advanceRun(id, deps);
    expect(["COMPLETED", "REJECTED"]).toContain(final);
    expect(fake.calls).toHaveLength(final === "COMPLETED" ? 1 : 0);
  });

  it("rejection ends the run without contacting PayPal; an unanswered review expires", async () => {
    const wf = await flow();
    await procurement(wf);
    const id = await pay(wf, usd("1500.00"));
    await advanceRun(id, deps);
    await approve((await approvalFor(id)).id, "REJECTED");
    expect(await advanceRun(id, deps)).toBe("REJECTED");
    const late = await pay(wf, usd("1500.00"));
    await advanceRun(late, deps);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    expect(await advanceRun(late, deps)).toBe("REJECTED");
    expect((await run(late)).outcome).toMatch(/expired without a decision; PayPal was not contacted/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("9–10 · reservation settles with what PayPal actually did", () => {
  it("PayPal refuses after the reservation → released, and the budget is free again", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    fake.script = async (_i, _c, n) => (n === 1 ? { status: "failed", retryable: false, error: { code: "INSUFFICIENT_FUNDS", message: "Sender has insufficient funds", status: 422, debugId: "dbg-422" } } : null);
    const id = await pay(wf, usd("900.00"));
    expect(await advanceRun(id, deps)).toBe("NEEDS_REVIEW");
    expect(await reservations(auth)).toEqual([expect.objectContaining({ status: "RELEASED", amount: "900.00" })]);
    // The full $1,000 is available again.
    expect(await advanceRun(await pay(wf, usd("1000.00")), deps)).toBe("COMPLETED");
  });

  it("no definitive answer → UNKNOWN, and the reservation stays held (still counted)", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    fake.script = async () => ({ status: "failed", retryable: true, error: { code: "TIMEOUT", message: "no response" } });
    const id = await pay(wf, usd("800.00"));
    for (let i = 0; i < 4; i++) await advanceRun(id, deps);
    const [ex] = await db().select().from(actionExecutions);
    expect(ex.status).toBe("UNKNOWN");
    expect(await reservations(auth)).toEqual([expect.objectContaining({ status: "RESERVED", amount: "800.00" })]);
    fake.script = null;
    expect(await advanceRun(await pay(wf, usd("300.00")), deps)).toBe("WAITING_APPROVAL"); // 800 held + 300 > 1,000
  });

  it("lost PayPal reply: recovery re-sends the same key; one object, one reservation, committed once", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    fake.script = async (intent, _c, n) => {
      if (n === 1) {
        fake.land(intent); // PayPal created it …
        return { status: "failed", retryable: true, error: { code: "NETWORK", message: "socket hang up" } }; // … but the reply was lost
      }
      return null;
    };
    const id = await pay(wf, usd("700.00"));
    await advanceRun(id, deps);
    expect(await advanceRun(id, deps)).toBe("COMPLETED");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].idempotencyKey).toBe(fake.calls[1].idempotencyKey);
    expect(fake.objects()).toBe(1);
    const rs = await reservations(auth);
    expect(rs).toEqual([expect.objectContaining({ amount: "700.00", status: "COMMITTED" })]);
    expect(await decisions(id)).toHaveLength(1); // authorized once, never re-authorized on replay
  });
});

describe("11–12 · changes while a run is waiting", () => {
  it("a new workflow version while approval is pending: the run finishes on its own version, once", async () => {
    const wf = await flow();
    await procurement(wf);
    const id = await pay(wf, usd("1500.00"));
    await advanceRun(id, deps);
    const v1 = (await run(id)).versionId;
    const g2 = payoutGraph();
    g2.nodes[1].config = { max: 1, period: "day", key: "bills-v2" };
    const saved = await saveDraft({ workspaceId: ws.id, userId: user.id, workflowId: wf, graph: g2 });
    expect(saved.ok && saved.version).toBe(2);
    expect((await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: wf })).ok).toBe(true);
    await approve((await approvalFor(id)).id);
    expect(await advanceRun(id, deps)).toBe("COMPLETED");
    expect((await run(id)).versionId).toBe(v1);
    expect(fake.calls).toHaveLength(1);
  });

  it("workflow paused while approval is pending: approving does not pay; resuming pays exactly once", async () => {
    const wf = await flow();
    await procurement(wf);
    const id = await pay(wf, usd("1500.00"));
    await advanceRun(id, deps);
    await setWorkflowState({ workspaceId: ws.id, userId: user.id, workflowId: wf, to: "PAUSED" });
    await approve((await approvalFor(id)).id);
    expect(await advanceRun(id, deps)).toBe("SUSPENDED");
    expect(fake.calls).toHaveLength(0);
    const r = await setWorkflowState({ workspaceId: ws.id, userId: user.id, workflowId: wf, to: "ACTIVE" });
    expect(r.ok && r.wake).toEqual([id]);
    expect(await advanceRun(id, deps)).toBe("COMPLETED");
    expect(fake.calls).toHaveLength(1);
  });

  it("authority suspended while approval is pending: the approval cannot revive it", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    const id = await pay(wf, usd("1500.00"));
    await advanceRun(id, deps);
    await setAuthorityStatus({ workspaceId: ws.id, userId: user.id, authorityId: auth, to: "SUSPENDED", reason: "Vendor review" });
    await approve((await approvalFor(id)).id);
    expect(await advanceRun(id, deps)).toBe("BLOCKED");
    expect((await run(id)).outcome).toMatch(/suspended: Vendor review/);
    expect(fake.calls).toHaveLength(0);
    expect(await reservations(auth)).toHaveLength(0);
  });

  it("authority suspended while a send is being retried: never re-sent, outcome UNKNOWN, budget held", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    fake.script = async (_i, _c, n) => (n === 1 ? { status: "failed", retryable: true, error: { code: "NETWORK", message: "timeout" } } : null);
    const id = await pay(wf, usd("400.00"));
    await advanceRun(id, deps); // attempt 1 got no answer
    await setAuthorityStatus({ workspaceId: ws.id, userId: user.id, authorityId: auth, to: "SUSPENDED", reason: "Fraud alert" });
    await advanceRun(id, deps);
    expect(fake.calls).toHaveLength(1);
    const [ex] = await db().select().from(actionExecutions);
    expect(ex).toMatchObject({ status: "UNKNOWN" });
    expect((ex.error as { code: string }).code).toBe("AUTHORITY_WITHDRAWN_AFTER_SEND");
    expect(await reservations(auth)).toEqual([expect.objectContaining({ status: "RESERVED" })]);
  });

  it("an edit that lowers the budget applies to the next decision", async () => {
    const wf = await flow();
    const auth = await procurement(wf);
    await advanceRun(await pay(wf, usd("400.00")), deps);
    const u = await updateAuthority({
      workspaceId: ws.id,
      userId: user.id,
      authorityId: auth,
      data: { name: "Cloud procurement", workflowIds: [wf], actions: ["paypal.payout"], counterpartyRule: "allowlist", counterparties: [{ id: ACME, name: "Acme Cloud" }], currencies: ["USD"], budgetAmount: "500", budgetPeriod: "month" },
    });
    expect(u).toMatchObject({ ok: true, version: 2 });
    const id = await pay(wf, usd("200.00"));
    expect(await advanceRun(id, deps)).toBe("WAITING_APPROVAL");
    expect((await decisions(id))[0].authorityVersion).toBe(2);
  });
});

describe("workflow-level budget and frequency nodes", () => {
  function budgetGraph(): WorkflowGraph {
    return {
      schemaVersion: 1,
      nodes: [
        { id: "bill", type: "trigger.manual", config: {} },
        { id: "budget", type: "policy.budget", label: "Cloud budget", config: { amountRef: "trigger.amount", budget: { value: "1000.00", currency: "USD" }, period: "month", budgetKey: "cloud" } },
        { id: "pay", type: "paypal.payout", config: { receiverRef: "trigger.supplier", amountRef: "trigger.amount", note: "x" } },
        end("paid", "completed"),
        end("over", "blocked"),
        end("refused", "needs_review"),
      ],
      edges: [
        { from: "bill", to: "budget", port: "next" },
        { from: "budget", to: "pay", port: "pass" },
        { from: "budget", to: "over", port: "block" },
        { from: "pay", to: "paid", port: "done" },
        { from: "pay", to: "refused", port: "error" },
      ],
    } as WorkflowGraph;
  }
  const nodeReservations = () => db().select().from(budgetReservations).where(eq(budgetReservations.scopeKey, "budget:cloud"));

  it("two simultaneous $600 against a $1,000 budget node: one passes, one is blocked", async () => {
    const wf = await flow(budgetGraph());
    await grantAuthority(ws.id, user.id, [wf]);
    fake.delayMs = 30;
    const [a, b] = [await pay(wf, usd("600.00")), await pay(wf, usd("600.00"))];
    const s = await Promise.all([advanceRun(a, deps), advanceRun(b, deps)]);
    expect(s.sort()).toEqual(["BLOCKED", "COMPLETED"]);
    expect(fake.calls).toHaveLength(1);
    expect(await nodeReservations()).toEqual([expect.objectContaining({ amount: "600.00", status: "COMMITTED" })]);
  });

  it("a node reservation is released when the PayPal action fails", async () => {
    const wf = await flow(budgetGraph());
    await grantAuthority(ws.id, user.id, [wf]);
    fake.script = async () => ({ status: "failed", retryable: false, error: { code: "RECEIVER_UNREGISTERED", message: "no", status: 422 } });
    await advanceRun(await pay(wf, usd("900.00")), deps);
    expect(await nodeReservations()).toEqual([expect.objectContaining({ status: "RELEASED" })]);
  });

  it("frequency node: the third pass in a day is blocked", async () => {
    const wf = await flow();
    await grantAuthority(ws.id, user.id, [wf]);
    const g = payoutGraph();
    g.nodes[1].config = { max: 2, period: "day", key: "tight" };
    const wf2 = await flow(g);
    await grantAuthority(ws.id, user.id, [wf2]);
    expect(await advanceRun(await pay(wf2, usd("1.00")), deps)).toBe("COMPLETED");
    expect(await advanceRun(await pay(wf2, usd("1.00")), deps)).toBe("COMPLETED");
    expect(await advanceRun(await pay(wf2, usd("1.00")), deps)).toBe("BLOCKED");
  });
});

describe("audit", () => {
  it("every decision, reservation and settlement is on a verifiable chain, with the reason readable", async () => {
    const wf = await flow();
    await procurement(wf);
    await advanceRun(await pay(wf, usd("500.00")), deps);
    const id = await pay(wf, usd("900.00"), "x@unknown.example");
    await advanceRun(id, deps);
    const { auditRecords } = await import("@/server/db/schema");
    const rows = await db().select().from(auditRecords).where(and(eq(auditRecords.workspaceId, ws.id)));
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["authority.created", "authority.decision", "action.prepared", "action.succeeded", "budget.committed", "node.approval_requested"]));
    expect(rows.find((r) => r.kind === "authority.decision" && r.summary.startsWith("REVIEW"))?.summary).toMatch(/x@unknown\.example is not an approved counterparty/);
    expect((await verifyChain(ws.id)).ok).toBe(true);
    const steps = await db().select().from(runSteps).where(eq(runSteps.runId, id));
    expect(steps.at(-1)?.explanation).toMatch(/PayPal has not been contacted/);
  });
});
