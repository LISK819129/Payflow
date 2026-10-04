/**
 * Real-Sandbox duplicate-money check. For a refund and a payout it:
 *   1. runs the real workflow (Refund desk / Supplier payouts) once;
 *   2. simulates the worst crash — PayPal accepted the call but PayFlow never
 *      stored the reply — by rewinding the action to SUBMITTING with an expired
 *      lease and no stored result;
 *   3. lets the normal recovery path (runAction) send it again, with the same
 *      PayPal-Request-Id;
 *   4. asks PayPal how many refunds / payout items now exist.
 * Pass = PayPal returned the same object and the count did not grow.
 * Sandbox only; prints no secrets.
 *
 *   pnpm paypal:idempotency:check <captureIdWithBalance> <orderIdOfThatCapture>
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { runAction } from "../src/server/actions/execute";
import { closeDb, db } from "../src/server/db/client";
import { stopBoss } from "../src/server/jobs/boss";
import { actionExecutions, budgetReservations, users, workflows } from "../src/server/db/schema";
import { paypal } from "../src/server/paypal/client";
import { advanceRun, startRun } from "../src/server/workflow/runtime/engine";
import { runtimeDeps } from "../src/server/workflow/runtime/deps";
import { merchantWorkspaceId } from "../src/server/workspace";

type OrderRefunds = { purchase_units?: { payments?: { refunds?: { id: string; amount: { value: string } }[] } }[] };

async function refundsOn(orderId: string) {
  const r = await paypal().request<OrderRefunds>({ method: "GET", path: `/v2/checkout/orders/${encodeURIComponent(orderId)}` });
  return r.data.purchase_units?.[0]?.payments?.refunds?.map((x) => x.id) ?? [];
}

async function payoutItems(batchId: string) {
  const r = await paypal().request<{ items?: { payout_item_id: string }[] }>({ method: "GET", path: `/v1/payments/payouts/${encodeURIComponent(batchId)}` });
  return r.data.items?.map((i) => i.payout_item_id) ?? [];
}

async function runOnce(workspaceId: string, userId: string, flowName: string, payload: Record<string, unknown>) {
  const [wf] = await db().select().from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.name, flowName)));
  const r = await startRun(
    { workflowId: wf.id, triggerKind: "manual", triggerRef: `manual:${randomUUID()}`, triggerPayload: payload, provenance: "USER_PROVIDED", startedBy: userId },
    runtimeDeps,
  );
  if (!("runId" in r)) throw new Error(`not started: ${r.skipped}`);
  for (let i = 0; i < 5; i++) await advanceRun(r.runId, runtimeDeps);
  const [ex] = await db().select().from(actionExecutions).where(eq(actionExecutions.runId, r.runId));
  return { runId: r.runId, ex };
}

/** The crash: PayPal has the object, PayFlow has no record of the reply. */
async function forgetReply(executionId: string) {
  await db()
    .update(actionExecutions)
    .set({ status: "SUBMITTING", leaseUntil: new Date(Date.now() - 1000), paypalRefs: [], paypalStatus: null, result: null, debugId: null, completedAt: null })
    .where(eq(actionExecutions.id, executionId));
}

async function main() {
  const [captureId, orderId] = process.argv.slice(2);
  if (!captureId || !orderId) throw new Error("usage: idempotency-check <captureId> <orderId>");
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(eq(users.workspaceId, workspaceId)).limit(1);
  const results: Record<string, unknown> = {};

  // ── Refund ──
  const before = await refundsOn(orderId);
  const refund = await runOnce(workspaceId, owner.id, "Refund desk", { captureId, amount: { value: "10.00", currency_code: "USD" }, reason: "Idempotency check" });
  const firstRefund = refund.ex.paypalRefs[0];
  const afterFirst = await refundsOn(orderId);
  await forgetReply(refund.ex.id);
  const replay = await runAction(refund.ex.id);
  const [refundAfter] = await db().select().from(actionExecutions).where(eq(actionExecutions.id, refund.ex.id));
  const afterReplay = await refundsOn(orderId);
  results.refund = {
    runId: refund.runId,
    idempotencyKey: refund.ex.idempotencyKey,
    firstRefundId: firstRefund,
    replayResult: replay,
    replayRefundId: refundAfter.paypalRefs[0],
    attempts: refundAfter.attempts,
    refundsOnOrder: { before: before.length, afterFirstSend: afterFirst.length, afterReplay: afterReplay.length },
    pass: firstRefund === refundAfter.paypalRefs[0] && afterReplay.length === afterFirst.length && afterFirst.length === before.length + 1,
  };

  // ── Payout ──
  const payout = await runOnce(workspaceId, owner.id, "Supplier payouts", {
    supplierEmail: "studio@type-foundry.example",
    amount: { value: "15.00", currency_code: "USD" },
    bill: "Idempotency check",
  });
  const firstBatch = payout.ex.paypalRefs[0];
  const itemsFirst = firstBatch ? await payoutItems(firstBatch) : [];
  await forgetReply(payout.ex.id);
  const replayP = await runAction(payout.ex.id);
  const [payoutAfter] = await db().select().from(actionExecutions).where(eq(actionExecutions.id, payout.ex.id));
  const itemsAfter = payoutAfter.paypalRefs[0] ? await payoutItems(payoutAfter.paypalRefs[0]) : [];
  results.payout = {
    runId: payout.runId,
    idempotencyKey: payout.ex.idempotencyKey,
    firstBatchId: firstBatch,
    replayResult: replayP,
    replayStatus: payoutAfter.status,
    replayBatchId: payoutAfter.paypalRefs[0] ?? null,
    replayError: payoutAfter.error,
    attempts: payoutAfter.attempts,
    itemsInBatch: { afterFirstSend: itemsFirst.length, afterReplay: itemsAfter.length },
    pass: !!firstBatch && firstBatch === payoutAfter.paypalRefs[0] && itemsAfter.length === 1,
  };

  // Phase 6: the authority reservation behind each action must exist once and be committed once.
  for (const k of ["refund", "payout"] as const) {
    const r = results[k] as { runId: string; pass: boolean };
    const [ex] = await db().select().from(actionExecutions).where(eq(actionExecutions.runId, r.runId));
    const rs = await db().select().from(budgetReservations).where(eq(budgetReservations.executionId, ex.id));
    Object.assign(r, {
      authorityDecisionId: ex.decisionId,
      reservations: rs.map((x) => ({ amount: x.amount, status: x.status })),
      pass: r.pass && rs.length === 1 && rs[0].status === "COMMITTED",
    });
  }
  console.log(JSON.stringify(results, null, 2));
}

main()
  .then(async () => {
    await stopBoss();
    await closeDb();
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
