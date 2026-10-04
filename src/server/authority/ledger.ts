import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import type { Tx } from "../db/client";
import { actionExecutions, budgetReservations, workflowRuns } from "../db/schema";
import type { PeriodWindow } from "./periods";
import type { Usage } from "./types";

/**
 * The budget/frequency ledger. Usage counts everything RESERVED or COMMITTED in
 * the period, so an in-flight reservation is visible to every concurrent request.
 * Callers serialise CHECK → RESERVE with a lock (authority row, or an advisory
 * lock per budget key) so two requests can never both see the same headroom.
 */

export async function usageFor(tx: Tx, workspaceId: string, scopeKey: string, w: PeriodWindow): Promise<Usage> {
  const [row] = await tx
    .select({
      committed: sql<string>`coalesce(sum(${budgetReservations.amount}) filter (where ${budgetReservations.status} = 'COMMITTED'), 0)::text`,
      reserved: sql<string>`coalesce(sum(${budgetReservations.amount}) filter (where ${budgetReservations.status} = 'RESERVED'), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.workspaceId, workspaceId),
        eq(budgetReservations.scopeKey, scopeKey),
        inArray(budgetReservations.status, ["RESERVED", "COMMITTED"]),
        sql`${budgetReservations.createdAt} >= ${w.start.toISOString()} and ${budgetReservations.createdAt} < ${w.end.toISOString()}`,
      ),
    );
  return { committed: row.committed, reserved: row.reserved, count: row.count };
}

/** Bounded wait for a ledger lock; on timeout the caller fails closed instead of guessing. */
let lockTimeoutMs = 5000;
export function setLedgerLockTimeoutForTests(ms: number | null) {
  lockTimeoutMs = ms ?? 5000;
}

/**
 * Runs `fn` in a savepoint with a lock timeout. Returns "unavailable" if the
 * ledger could not be locked or read, so the caller can fail closed.
 */
export async function withLedgerLock<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<T | "unavailable"> {
  try {
    return await tx.transaction(async (sp) => {
      await sp.execute(sql.raw(`set local lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`));
      const out = await fn(sp);
      await sp.execute(sql.raw("set local lock_timeout to default"));
      return out;
    });
  } catch (e) {
    // 55P03 lock_not_available (lock_timeout); drizzle wraps the driver error in `cause`.
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "55P03" || ledgerFaultForTests === "throw") return "unavailable";
    throw e;
  }
}

/** Test hook: simulate a ledger that cannot be read. */
let ledgerFaultForTests: "throw" | null = null;
export function setLedgerFaultForTests(fault: "throw" | null) {
  ledgerFaultForTests = fault;
}
export function ledgerFault() {
  if (ledgerFaultForTests === "throw") throw new Error("ledger unavailable (test fault)");
}

/** Advisory lock for a workflow-level budget/frequency key (no row to lock). */
export async function lockScope(tx: Tx, workspaceId: string, scopeKey: string) {
  ledgerFault();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${workspaceId}|${scopeKey}`}))`);
}

/**
 * Settles a run's workflow-level reservations (budget/frequency nodes) when the
 * run ends: COMMIT if a PayPal action on the run succeeded, HOLD if one has an
 * unknown or unfinished outcome, otherwise RELEASE.
 */
export async function settleRunReservations(tx: Tx, runId: string) {
  const open = await tx
    .select()
    .from(budgetReservations)
    .where(and(eq(budgetReservations.runId, runId), isNull(budgetReservations.executionId), eq(budgetReservations.status, "RESERVED")));
  if (open.length === 0) return;
  const execs = await tx.select({ status: actionExecutions.status }).from(actionExecutions).where(eq(actionExecutions.runId, runId));
  const [run] = await tx.select({ workspaceId: workflowRuns.workspaceId }).from(workflowRuns).where(eq(workflowRuns.id, runId));
  const pending = execs.some((e) => e.status === "UNKNOWN" || e.status === "PREPARED" || e.status === "SUBMITTING");
  const done = execs.some((e) => e.status === "SUCCEEDED");
  const how = pending ? "hold" : done ? "commit" : "release";
  const reason = pending ? "A PayPal action on this run has no definitive outcome; still counted" : done ? "PayPal action on this run succeeded" : "No PayPal action on this run succeeded";
  if (how !== "hold") {
    await tx
      .update(budgetReservations)
      .set({ status: how === "commit" ? "COMMITTED" : "RELEASED", settledAt: new Date(), settleReason: reason })
      .where(inArray(budgetReservations.id, open.map((r) => r.id)));
  } else {
    await tx.update(budgetReservations).set({ settleReason: reason }).where(inArray(budgetReservations.id, open.map((r) => r.id)));
  }
  await appendAudit(tx, {
    workspaceId: run.workspaceId,
    actor: "system",
    kind: `budget.${how === "commit" ? "committed" : how === "release" ? "released" : "held"}`,
    summary: `${open.length} workflow budget/frequency reservation(s) ${how === "commit" ? "committed" : how === "release" ? "released" : "held"}: ${reason}`,
    payload: { reservations: open.map((r) => ({ id: r.id, scope: r.scopeKey, amount: r.amount, currency: r.currency })) },
    runId,
  });
}
