import { and, eq, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { db, type Tx } from "../db/client";
import { actionExecutions, paypalEvents, workflowRuns, workflows } from "../db/schema";
import { authorityProvider } from "../authority";
import { checkAgentBinding } from "../agents/binding";
import { eventStatus } from "./event-link";
import { isGenuineWrite, livePayPalWrite, type PayPalWrite } from "./capability";
import type { ActionIntent } from "./types";

/** After this many attempts with no definitive answer, the outcome is UNKNOWN and the run fails closed. */
export const MAX_ACTION_ATTEMPTS = 3;
const LEASE_SECONDS = 90;

export type ExecutionRow = typeof actionExecutions.$inferSelect;

/** A Postgres text[] literal built from parameters (drizzle expands bare JS arrays into lists). */
function textArray(values: string[]) {
  return values.length ? sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]` : sql`'{}'::text[]`;
}

/**
 * Records the intent as PREPARED inside the caller's transaction (no network
 * here). Idempotent on the intent's key: preparing the same (run, node) twice
 * returns the existing execution.
 */
export async function prepareExecution(tx: Tx, intent: ActionIntent, executor: string): Promise<ExecutionRow> {
  const [row] = await tx
    .insert(actionExecutions)
    .values({
      workspaceId: intent.workspaceId,
      runId: intent.runId,
      nodeId: intent.nodeId,
      kind: intent.kind,
      idempotencyKey: intent.idempotencyKey,
      amountValue: intent.amount?.value ?? null,
      currency: intent.amount?.currency ?? null,
      counterparty: intent.counterparty,
      targetRef: intent.target?.id ?? null,
      intent,
      authorization: intent.authorization,
      executor,
      provenance: intent.provenance,
    })
    .onConflictDoNothing({ target: actionExecutions.idempotencyKey })
    .returning();
  if (row) {
    await appendAudit(tx, {
      workspaceId: intent.workspaceId,
      actor: "system",
      kind: "action.prepared",
      summary: `${intent.kind} prepared${intent.amount ? ` · ${intent.amount.value} ${intent.amount.currency}` : ""}${intent.counterparty ? ` → ${intent.counterparty}` : ""}${intent.target ? ` · ${intent.target.type} ${intent.target.id}` : ""}`,
      payload: { executionId: row.id, idempotencyKey: intent.idempotencyKey, gates: intent.authorization.gates.map((g) => `${g.nodeId}:${g.port}`), executor },
      runId: intent.runId,
      paypalRef: intent.target?.id ?? null,
    });
    return row;
  }
  const [existing] = await tx.select().from(actionExecutions).where(eq(actionExecutions.idempotencyKey, intent.idempotencyKey));
  return existing;
}

/** "halted": the workflow is paused or frozen, so nothing was sent; the run suspends and resumes later. */
export type RunActionResult = "settled" | "busy" | "retry_later" | "halted";

/**
 * Last check before PayPal is contacted. A paused/frozen workflow defers the
 * send. An authority that was suspended, revoked or expired after the decision
 * stops it: if nothing was ever sent, the action is cancelled and its budget
 * released; if an earlier attempt may have reached PayPal, the outcome is
 * UNKNOWN and the budget stays held (fail closed, never re-sent).
 */
async function preflight(executionId: string): Promise<RunActionResult | null> {
  const [row] = await db()
    .select({ ex: actionExecutions, wf: workflows })
    .from(actionExecutions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, actionExecutions.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(actionExecutions.id, executionId));
  if (!row || !["PREPARED", "SUBMITTING"].includes(row.ex.status)) return null;
  const { ex, wf } = row;
  if (wf.state === "PAUSED" || (wf.state === "FROZEN" && wf.frozenByRunId !== ex.runId)) return "halted";
  const authorityIds = (ex.intent as ActionIntent).authorization.authority?.authorityIds ?? [];
  // Agent-started runs: the receipt must be intact, the agent still active, the action exactly what it asked for.
  const binding = await checkAgentBinding(db(), ex.runId, ex.intent as ActionIntent);
  if (binding.ok && authorityIds.length === 0) return null;
  return db().transaction(async (tx) => {
    const ok = binding.ok ? await authorityProvider().usable(tx, authorityIds, new Date()) : { ok: false as const, reason: binding.message };
    if (ok.ok) return null;
    const code = binding.ok ? "AUTHORITY_WITHDRAWN" : binding.code;
    const neverSent = ex.attempts === 0;
    const [changed] = await tx
      .update(actionExecutions)
      .set(
        neverSent
          ? { status: "FAILED", error: { code, message: ok.reason }, completedAt: new Date(), leaseUntil: null }
          : { status: "UNKNOWN", error: { code: `${code}_AFTER_SEND`, message: `${ok.reason}; an earlier attempt may have reached PayPal, so it is not re-sent` }, completedAt: new Date(), leaseUntil: null },
      )
      .where(and(eq(actionExecutions.id, executionId), eq(actionExecutions.attempts, ex.attempts), sql`${actionExecutions.status} in ('PREPARED','SUBMITTING')`))
      .returning({ id: actionExecutions.id });
    if (!changed) return "busy" as const; // another worker moved it on; let it finish
    await authorityProvider().settle(tx, executionId, neverSent ? "release" : "hold", neverSent ? `Not sent: ${ok.reason}` : `Outcome unknown: ${ok.reason}`);
    await appendAudit(tx, {
      workspaceId: ex.workspaceId,
      actor: "system",
      kind: neverSent ? "action.cancelled" : "action.unknown",
      summary: `${ex.kind} ${neverSent ? "cancelled before PayPal was contacted" : "stopped; outcome unknown"}: ${ok.reason}`,
      payload: { executionId, authorityIds, attempts: ex.attempts },
      runId: ex.runId,
    });
    return "settled" as const;
  });
}

/**
 * Performs (or resumes) one prepared action. Only the caller that claims the
 * lease talks to the gateway; a crash mid-call leaves the lease to expire and
 * the next attempt replays the same idempotency key, which PayPal deduplicates.
 */
export async function runAction(executionId: string, write: PayPalWrite = livePayPalWrite()): Promise<RunActionResult> {
  // Only a capability issued outside a Test/Observe sandbox can reach PayPal.
  if (!isGenuineWrite(write)) throw new Error("runAction requires a genuine PayPal write capability");
  const stop = await preflight(executionId);
  if (stop) return stop;
  const [claimed] = await db()
    .update(actionExecutions)
    .set({
      status: "SUBMITTING",
      attempts: sql`${actionExecutions.attempts} + 1`,
      leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
      submittedAt: sql`coalesce(${actionExecutions.submittedAt}, now())`,
    })
    .where(
      and(
        eq(actionExecutions.id, executionId),
        sql`(${actionExecutions.status} = 'PREPARED' or (${actionExecutions.status} = 'SUBMITTING' and ${actionExecutions.leaseUntil} < now()))`,
      ),
    )
    .returning();

  if (!claimed) {
    const [row] = await db().select({ status: actionExecutions.status }).from(actionExecutions).where(eq(actionExecutions.id, executionId));
    return row && ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(row.status) ? "settled" : "busy";
  }

  const intent = claimed.intent as ActionIntent;
  const audit = (tx: Tx, kind: string, summary: string, payload: Record<string, unknown>) =>
    appendAudit(tx, { workspaceId: claimed.workspaceId, actor: kind === "action.succeeded" ? "paypal" : "system", kind, summary, payload: { executionId, ...payload }, runId: claimed.runId, paypalRef: claimed.targetRef });

  if (claimed.attempts > MAX_ACTION_ATTEMPTS) {
    await db().transaction(async (tx) => {
      await tx.update(actionExecutions).set({ status: "UNKNOWN", leaseUntil: null, completedAt: new Date() }).where(eq(actionExecutions.id, executionId));
      await audit(tx, "action.unknown", `${claimed.kind}: no definitive answer from PayPal after ${MAX_ACTION_ATTEMPTS} attempts; needs review`, { lastError: claimed.error });
      await authorityProvider().settle(tx, executionId, "hold", "No definitive answer from PayPal; still counted against the budget");
    });
    return "settled";
  }

  const gateway = write.gatewayFor(intent);
  const outcome = await gateway.execute(intent, {
    previous: (claimed.result as Record<string, unknown> | null) ?? null,
    attempt: claimed.attempts,
    checkpoint: async (refs, partial) => {
      await db()
        .update(actionExecutions)
        .set({ paypalRefs: sql`(select array(select distinct unnest(${actionExecutions.paypalRefs} || ${textArray(refs)})))`, result: partial })
        .where(eq(actionExecutions.id, executionId));
    },
  });

  if (outcome.status === "succeeded") {
    await db().transaction(async (tx) => {
      await tx
        .update(actionExecutions)
        .set({
          status: "SUCCEEDED",
          paypalRefs: outcome.paypalRefs,
          paypalStatus: outcome.paypalStatus,
          debugId: outcome.debugId,
          result: outcome.result,
          error: null,
          leaseUntil: null,
          completedAt: new Date(),
        })
        .where(eq(actionExecutions.id, executionId));
      await audit(tx, "action.succeeded", `${claimed.kind} succeeded at PayPal: ${outcome.paypalStatus} · ${outcome.paypalRefs.join(", ")}`, {
        paypalRefs: outcome.paypalRefs,
        paypalStatus: outcome.paypalStatus,
        debugId: outcome.debugId,
        attempt: claimed.attempts,
      });
      await bindEarlierEvents(tx, { workspaceId: claimed.workspaceId, executionId, refs: outcome.paypalRefs });
      // COMMIT: the money (or message) really went out.
      await authorityProvider().settle(tx, executionId, "commit", `PayPal ${outcome.paypalStatus ?? "accepted"} · ${outcome.paypalRefs[0] ?? ""}`.trim());
    });
    return "settled";
  }

  if (outcome.retryable && claimed.attempts < MAX_ACTION_ATTEMPTS) {
    // Release the lease so the next attempt (same key) can run; PayPal dedupes if the first one landed.
    await db().transaction(async (tx) => {
      await tx.update(actionExecutions).set({ leaseUntil: sql`now()`, error: outcome.error, debugId: outcome.error.debugId ?? null }).where(eq(actionExecutions.id, executionId));
      await audit(tx, "action.retry", `${claimed.kind}: ${outcome.error.message}; will retry with the same idempotency key`, { error: outcome.error, attempt: claimed.attempts });
    });
    return "retry_later";
  }

  const finalStatus = outcome.retryable ? "UNKNOWN" : "FAILED";
  await db().transaction(async (tx) => {
    await tx
      .update(actionExecutions)
      .set({ status: finalStatus, error: outcome.error, debugId: outcome.error.debugId ?? null, leaseUntil: null, completedAt: new Date() })
      .where(eq(actionExecutions.id, executionId));
    await audit(tx, finalStatus === "FAILED" ? "action.failed" : "action.unknown", `${claimed.kind} ${finalStatus === "FAILED" ? "failed" : "outcome unknown"}: ${outcome.error.code} — ${outcome.error.message}`, {
      error: outcome.error,
      attempt: claimed.attempts,
    });
    // RELEASE on PayPal's definitive refusal; HOLD when we cannot know whether it happened.
    await authorityProvider().settle(
      tx,
      executionId,
      finalStatus === "FAILED" ? "release" : "hold",
      finalStatus === "FAILED" ? `PayPal refused: ${outcome.error.code}` : `Outcome unknown: ${outcome.error.code}`,
    );
  });
  return "settled";
}

/** Links a verified PayPal event back to the action that caused it. */
export async function confirmActionsFromEvent(tx: Tx, input: { workspaceId: string; eventId: string; eventType: string; refs: string[]; status?: string | null; executionId?: string }) {
  const kinds = input.eventType.startsWith("PAYMENT.CAPTURE.REFUNDED")
    ? ["paypal.refund"]
    : input.eventType.startsWith("PAYMENT.PAYOUTS")
      ? ["paypal.payout"]
      : input.eventType.startsWith("INVOICING.INVOICE")
        ? ["paypal.invoice_send", "paypal.invoice_remind"]
        : input.eventType === "PAYMENT.CAPTURE.COMPLETED" || input.eventType === "CHECKOUT.ORDER.COMPLETED"
          ? ["paypal.order_capture"]
          : [];
  const refs = input.refs.filter(Boolean);
  if (kinds.length === 0 || refs.length === 0) return [];
  // The first matching event confirms the action; every later one only updates the status PayPal reports.
  const rows = await tx
    .update(actionExecutions)
    .set({
      confirmedByEventId: sql`coalesce(${actionExecutions.confirmedByEventId}, ${input.eventId})`,
      confirmedAt: sql`coalesce(${actionExecutions.confirmedAt}, now())`,
      lastEventType: input.eventType,
      lastEventStatus: input.status ?? null,
    })
    .where(
      and(
        eq(actionExecutions.workspaceId, input.workspaceId),
        sql`${actionExecutions.kind} = any(${textArray(kinds)})`,
        sql`${actionExecutions.paypalRefs} && ${textArray(refs)}`,
        input.executionId ? eq(actionExecutions.id, input.executionId) : undefined,
      ),
    )
    .returning({ id: actionExecutions.id, kind: actionExecutions.kind, runId: actionExecutions.runId, confirmedBy: actionExecutions.confirmedByEventId });
  for (const r of rows) {
    const first = r.confirmedBy === input.eventId;
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: "paypal",
      kind: first ? "action.confirmed" : "action.event",
      summary: `${input.eventType} ${first ? "confirms" : "updates"} ${r.kind} (${refs[0]})${input.status ? ` · ${input.status}` : ""}`,
      payload: { executionId: r.id, eventId: input.eventId, status: input.status ?? null },
      runId: r.runId,
      paypalRef: refs[0],
    });
  }
  return rows;
}

/**
 * PayPal's webhook can arrive before PayFlow records the action's reply (fast
 * webhooks, or a reply recovered after a crash). When an action succeeds, apply
 * any PayPal-confirmed events already received for its ids, oldest first.
 */
export async function bindEarlierEvents(tx: Tx, input: { workspaceId: string; executionId: string; refs: string[] }) {
  if (input.refs.length === 0) return;
  const refs = textArray(input.refs);
  const earlier = await tx
    .select({ eventId: paypalEvents.eventId, eventType: paypalEvents.eventType, raw: paypalEvents.raw })
    .from(paypalEvents)
    .where(
      and(
        eq(paypalEvents.workspaceId, input.workspaceId),
        // Real events are routed only after PayPal's own event store confirmed them.
        eq(paypalEvents.provenance, "REAL_PAYPAL_SANDBOX"),
        sql`${paypalEvents.routedAt} is not null`,
        sql`array[${paypalEvents.raw}#>>'{resource,id}', ${paypalEvents.raw}#>>'{resource,invoice,id}', ${paypalEvents.raw}#>>'{resource,payout_batch_id}', ${paypalEvents.raw}#>>'{resource,batch_header,payout_batch_id}'] && ${refs}`,
      ),
    )
    .orderBy(paypalEvents.receivedAt);
  for (const e of earlier) {
    const resource = ((e.raw as { resource?: Record<string, unknown> }).resource ?? {}) as Record<string, unknown>;
    await confirmActionsFromEvent(tx, { workspaceId: input.workspaceId, eventId: e.eventId, eventType: e.eventType, refs: input.refs, status: eventStatus(resource), executionId: input.executionId });
  }
}
