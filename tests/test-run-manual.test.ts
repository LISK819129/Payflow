import { readFileSync } from "node:fs";
import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyFields, fieldsFor, manualPayload, TEST_RUN_WAIT_MS, withTimeout } from "@/components/simulation/test-input";
import { setGatewayForTests } from "@/server/actions/paypal-gateway";
import type { ActionGateway, ActionIntent, ActionOutcome } from "@/server/actions/types";
import { closeDb, db } from "@/server/db/client";
import { actionExecutions, aiUsage, approvals, budgetReservations, simulations, workflowRuns } from "@/server/db/schema";
import { MockAnalysisProvider } from "@/server/intelligence/mock";
import { setAnalysisProviderForTests } from "@/server/intelligence/runner";
import { simulate } from "@/server/simulation/run";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { createWorkflow } from "@/server/workflow/service";
import { grantAuthority } from "./support/authority";
import { createUser, createWorkspace, resetTestDb } from "./support/db";

/**
 * Regression (2026-10-06): a person compiled a brand-new manual payout workflow
 * with the AI compiler, pressed "Test this flow" and saw "Testing…" with no
 * result. The graph below is the REAL gpt-5.4-mini output for that instruction,
 * replayed at $0. The Test Run form had sent the request without the amount (an
 * empty field showed a "180.00" placeholder that looked filled in).
 */
const FIXTURE = JSON.parse(readFileSync("tests/fixtures/real-openai/manual-payout-200-graph.json", "utf8")) as { graph: WorkflowGraph };
const ACME = "sb-yluat53193698@personal.example.com";
const AWS = "sb-mnylb53193692@personal.example.com";

/** MOCK_TEST: records any PayPal call; a Test Run must never reach it. */
class FakePayPal implements ActionGateway {
  readonly name = "fake-paypal";
  calls: ActionIntent[] = [];
  async execute(intent: ActionIntent): Promise<ActionOutcome> {
    this.calls.push(intent);
    return { status: "succeeded", paypalRefs: ["LIVE"], paypalStatus: "PENDING", debugId: "dbg", result: {} };
  }
}

let fake: FakePayPal;
let ws: { id: string };
let user: { id: string };

beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("PixelForge");
  user = await createUser(ws.id);
  fake = new FakePayPal();
  setGatewayForTests(fake);
  setAnalysisProviderForTests(new MockAnalysisProvider());
});
afterEach(() => {
  setGatewayForTests(null);
  setAnalysisProviderForTests(undefined);
  vi.useRealTimers();
});
afterAll(closeDb);

describe("Test Run form (what the browser sends)", () => {
  it("offers exactly the fields the compiled workflow reads, typed by use", () => {
    expect(fieldsFor(FIXTURE.graph)).toEqual([
      { key: "supplierEmail", kind: "text" },
      { key: "amount", kind: "money" },
    ]);
  });

  it("sends what was typed, and nothing that was not", () => {
    const fields = fieldsFor(FIXTURE.graph);
    expect(manualPayload(fields, { supplierEmail: ` ${ACME} ` }, { amount: { value: "180", currency: "usd" } })).toEqual({ supplierEmail: ACME, amount: { value: "180", currency_code: "USD" } });
    // The failing case: amount left empty. It is absent (never guessed) and reported as empty before running.
    expect(manualPayload(fields, { supplierEmail: ACME }, {})).toEqual({ supplierEmail: ACME });
    expect(emptyFields(fields, { supplierEmail: ACME }, {})).toEqual(["amount"]);
    expect(emptyFields(fields, { supplierEmail: ACME }, { amount: { value: "  ", currency: "USD" } })).toEqual(["amount"]);
    expect(emptyFields(fields, { supplierEmail: ACME }, { amount: { value: "180", currency: "USD" } })).toEqual([]);
  });

  it("never waits forever: a request with no answer becomes a timeout", async () => {
    vi.useFakeTimers();
    const never = new Promise<{ ok: true; id: string }>(() => {});
    const raced = withTimeout(never, TEST_RUN_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TEST_RUN_WAIT_MS);
    await expect(raced).resolves.toBe("timeout");
    vi.useRealTimers();
    await expect(withTimeout(Promise.resolve({ ok: true, id: "x" }), 1000)).resolves.toEqual({ ok: true, id: "x" });
    await expect(withTimeout(Promise.reject(new Error("network")), 1000)).rejects.toThrow("network");
  });
});

describe("Test Run of a newly AI-compiled manual payout workflow", () => {
  async function compiledDraft() {
    const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: "Approve software supplier payouts", graph: FIXTURE.graph, provenance: "AI_GENERATED" });
    if (!c.ok) throw new Error(JSON.stringify(c));
    return c.workflowId; // a DRAFT, exactly as the compiler leaves it
  }
  const test = async (workflowId: string, payload: Record<string, unknown>) => {
    const t0 = Date.now();
    const r = await simulate({ mode: "TEST", workspaceId: ws.id, workflowId, trigger: { kind: "manual", payload }, userId: user.id });
    if (!r.ok) throw new Error(r.error);
    const [s] = await db().select().from(simulations).where(eq(simulations.id, r.id));
    return { ...s, ms: Date.now() - t0 };
  };
  const money = (v: string) => ({ value: v, currency_code: "USD" });

  it("answers immediately with a reason for every input, and never touches PayPal, budget or AI", async () => {
    const wf = await compiledDraft();

    // Exactly what the browser sent: no amount → the engine fails safe, it does not hang.
    const missing = await test(wf, { supplierEmail: ACME });
    expect(missing.verdict).toBe("WOULD_REVIEW");
    expect(missing.headline).toMatch(/no amount at trigger\.amount/);

    // $180 within the workflow's own rules — but no person has delegated authority yet.
    const noAuthority = await test(wf, { supplierEmail: ACME, amount: money("180") });
    expect(noAuthority.verdict).toBe("WOULD_REVIEW");
    expect(noAuthority.headline).toMatch(/No delegated authority covers Payout/);

    // Once a person delegates authority for these suppliers:
    await grantAuthority(ws.id, user.id, [wf], { actions: ["paypal.payout"], counterpartyRule: "allowlist", counterparties: [{ id: ACME, name: "Acme Cloud" }, { id: AWS, name: "AWS" }], perTransactionMax: "500" });
    const allowed = await test(wf, { supplierEmail: ACME, amount: money("180") });
    expect(allowed.verdict).toBe("WOULD_ALLOW");
    expect(allowed.wouldAction).toMatchObject({ kind: "paypal.payout", amount: { value: "180", currency: "USD" } });

    // $350: above the workflow's own $200 line → its approval step asks a person.
    const review = await test(wf, { supplierEmail: ACME, amount: money("350") });
    expect(review.verdict).toBe("WOULD_REVIEW");
    expect(review.steps as { nodeId: string; status: string }[]).toContainEqual(expect.objectContaining({ nodeId: "manual_approval", status: "WAITING" }));

    // Blocked Vendor never reaches the payout.
    const blocked = await test(wf, { supplierEmail: "payments@blocked-vendor.example", amount: money("50") });
    expect(blocked.verdict).not.toBe("WOULD_ALLOW");
    expect(blocked.wouldAction).toBeNull();

    for (const s of [missing, noAuthority, allowed, review, blocked]) {
      expect(s.ms).toBeLessThan(5000);
      expect(s.externalActionsDisabled).toBe(true);
    }
    // A Test Run leaves nothing behind but its own record.
    expect(fake.calls).toEqual([]);
    for (const t of [budgetReservations, actionExecutions, approvals, workflowRuns, aiUsage]) {
      const [{ n }] = await db().select({ n: count() }).from(t);
      expect(n).toBe(0);
    }
  });
});
