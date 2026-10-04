import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { canonicalJson } from "../audit/canonical-json";
import type { Tx } from "../db/client";
import { actionExecutions, authorities, authorityDecisions, budgetReservations } from "../db/schema";
import { ACTION_LABEL, combine, evaluateAuthority, money } from "./evaluate";
import { ledgerFault, usageFor, withLedgerLock } from "./ledger";
import { periodWindow } from "./periods";
import type { ApprovalRow, AuthorityOutcome, AuthorityProvider, AuthorityRequest, AuthorityResult, AuthorityRow, BudgetSnapshot, Evaluation, FrequencySnapshot, Usage } from "./types";

/** Identity of a request: a person's approval is valid only for exactly this action. */
export function requestFingerprint(req: AuthorityRequest): string {
  return createHash("sha256")
    .update(canonicalJson({ kind: req.kind, amount: req.amount, counterparty: req.counterparty?.toLowerCase() ?? null, target: req.target, runId: req.runId, nodeId: req.nodeId }))
    .digest("hex");
}

export const scopeKeyFor = (authorityId: string) => `authority:${authorityId}`;

/** Test hook: widens the window between reading usage and reserving, to prove the lock closes it. */
let afterUsageRead: (() => Promise<void>) | null = null;
export function setAfterUsageReadForTests(fn: (() => Promise<void>) | null) {
  afterUsageRead = fn;
}

/**
 * PayFlow's own authority service. CHECK → RESERVE happens inside the run's
 * step transaction while every matching authority row is locked FOR UPDATE, so
 * a second request for the same budget waits, then sees the first reservation.
 */
export class InternalAuthorityProvider implements AuthorityProvider {
  readonly name = "payflow-internal";

  async authorize(tx: Tx, req: AuthorityRequest, opts: { approval: ApprovalRow | null; now: Date }): Promise<AuthorityResult> {
    const { now } = opts;
    const matching = and(
      eq(authorities.workspaceId, req.workspaceId),
      sql`${authorities.workflowIds} @> ${JSON.stringify([req.workflowId])}::jsonb`,
      sql`${authorities.actions} @> ${JSON.stringify([req.kind])}::jsonb`,
    );

    // Lock every authority that covers this (workflow, action), in id order (no deadlocks), and read usage under the lock.
    const locked = await withLedgerLock(tx, async (sp) => {
      ledgerFault();
      const rows = await sp.select().from(authorities).where(matching).orderBy(asc(authorities.id)).for("update");
      const usage = new Map<string, { budget: Usage | null; frequency: Usage | null }>();
      for (const a of rows) {
        usage.set(a.id, {
          budget: a.budgetAmount && a.budgetPeriod ? await usageFor(sp, req.workspaceId, scopeKeyFor(a.id), periodWindow(a.budgetPeriod, now)) : null,
          frequency: a.maxCount && a.countPeriod ? await usageFor(sp, req.workspaceId, scopeKeyFor(a.id), periodWindow(a.countPeriod, now)) : null,
        });
      }
      if (afterUsageRead) await afterUsageRead();
      return { rows, usage };
    });

    // Ledger unreadable: still evaluate the standing rules (a suspended authority must still DENY), but nothing can pass on budget.
    const unavailable = locked === "unavailable";
    const rows: AuthorityRow[] = unavailable ? await tx.select().from(authorities).where(matching).orderBy(asc(authorities.id)) : locked.rows;

    const evaluations: Evaluation[] = [];
    const budget: BudgetSnapshot[] = [];
    const frequency: FrequencySnapshot[] = [];
    if (rows.length === 0) {
      evaluations.push({ check: "authority", result: "review", detail: `No delegated authority covers ${ACTION_LABEL[req.kind] ?? req.kind} for this workflow` });
    }
    if (unavailable) evaluations.push({ check: "state", result: "review", detail: "Budget/frequency state could not be locked and read; nothing passes on limits" });
    for (const a of rows) {
      const u = unavailable ? { budget: "unavailable" as const, frequency: "unavailable" as const } : locked.usage.get(a.id)!;
      const r = evaluateAuthority(a, req, u, now);
      evaluations.push(...r.evaluations);
      if (r.budget) budget.push(r.budget);
      if (r.frequency) frequency.push(r.frequency);
    }
    // Several authorities: every one of them must allow (the safest reading of overlapping policies).
    const decision = combine(evaluations.map((e) => e.result));
    const fingerprint = requestFingerprint(req);
    const humanApproved = !!opts.approval && opts.approval.status === "APPROVED" && (opts.approval.summary as { fingerprint?: string }).fingerprint === fingerprint;
    const outcome: AuthorityOutcome = decision === "REVIEW" && humanApproved ? "ALLOW_AFTER_HUMAN_APPROVAL" : decision;
    const blocking = evaluations.filter((e) => e.result === (decision === "DENY" ? "deny" : "review"));
    const reason = decision === "ALLOW" ? "Within delegated authority" : blocking.map((e) => e.detail).join("; ");

    const [d] = await tx
      .insert(authorityDecisions)
      .values({
        workspaceId: req.workspaceId,
        runId: req.runId,
        nodeId: req.nodeId,
        workflowId: req.workflowId,
        versionId: req.versionId,
        provider: this.name,
        authorityId: rows.length === 1 ? rows[0].id : null,
        authorityVersion: rows.length === 1 ? rows[0].version : null,
        authoritySnapshot: rows.map(snapshot),
        request: { ...req, fingerprint },
        evaluations,
        budget,
        frequency,
        decision,
        approvalId: humanApproved ? opts.approval!.id : null,
        outcome,
      })
      .returning({ id: authorityDecisions.id });

    // RESERVE: only when allowed, and in the same transaction as the check above.
    const reservationIds: string[] = [];
    if (outcome === "ALLOW" || outcome === "ALLOW_AFTER_HUMAN_APPROVAL") {
      for (const a of rows) {
        if (!(a.budgetAmount && a.budgetPeriod) && !(a.maxCount && a.countPeriod)) continue;
        const inLimitCcy = req.amount && req.amount.currency === a.currencies[0];
        const w = periodWindow(a.budgetPeriod ?? a.countPeriod!, now);
        const [r] = await tx
          .insert(budgetReservations)
          .values({
            workspaceId: req.workspaceId,
            scopeKey: scopeKeyFor(a.id),
            periodKey: w.key,
            authorityId: a.id,
            amount: inLimitCcy ? req.amount!.value : null,
            currency: inLimitCcy ? req.amount!.currency : null,
            runId: req.runId,
            nodeId: req.nodeId,
            decisionId: d.id,
            override: outcome === "ALLOW_AFTER_HUMAN_APPROVAL",
            approvalId: humanApproved ? opts.approval!.id : null,
            createdAt: now,
          })
          .returning({ id: budgetReservations.id });
        reservationIds.push(r.id);
      }
      if (reservationIds[0]) await tx.update(authorityDecisions).set({ reservationId: reservationIds[0] }).where(eq(authorityDecisions.id, d.id));
    }

    const what = `${ACTION_LABEL[req.kind] ?? req.kind}${req.amount ? ` ${money(req.amount.value, req.amount.currency)}` : ""}${req.counterparty ? ` → ${req.counterparty}` : ""}`;
    const b = budget[0];
    await appendAudit(tx, {
      workspaceId: req.workspaceId,
      actor: "system",
      kind: "authority.decision",
      summary:
        `${outcome.replaceAll("_", " ")}: ${what}` +
        (rows.length ? ` · by ${rows.map((a) => `“${a.name}” v${a.version}`).join(", ")}` : " · no authority") +
        (b ? ` · ${b.periodLabel} ${money(b.after, b.currency)} of ${money(b.limit, b.currency)}` : "") +
        (decision !== "ALLOW" ? ` · ${reason}` : "") +
        (reservationIds.length ? ` · reserved` : ""),
      payload: { decisionId: d.id, decision, outcome, evaluations, budget, frequency, reservationIds, approvalId: humanApproved ? opts.approval!.id : null },
      workflowId: req.workflowId,
      runId: req.runId,
    });

    return { decisionId: d.id, decision, outcome, authorityIds: rows.map((a) => a.id), evaluations, budget, frequency, reason, provider: this.name };
  }

  async linkExecution(tx: Tx, result: AuthorityResult, executionId: string) {
    await tx.update(budgetReservations).set({ executionId }).where(eq(budgetReservations.decisionId, result.decisionId));
    await tx
      .update(actionExecutions)
      .set({ authorityId: result.authorityIds.length === 1 ? result.authorityIds[0] : null, decisionId: result.decisionId })
      .where(eq(actionExecutions.id, executionId));
  }

  async settle(tx: Tx, executionId: string, how: "commit" | "release" | "hold", reason: string) {
    const rows = await tx
      .update(budgetReservations)
      .set(how === "hold" ? { settleReason: reason } : { status: how === "commit" ? "COMMITTED" : "RELEASED", settledAt: new Date(), settleReason: reason })
      .where(and(eq(budgetReservations.executionId, executionId), eq(budgetReservations.status, "RESERVED")))
      .returning();
    for (const r of rows) {
      await appendAudit(tx, {
        workspaceId: r.workspaceId,
        actor: "system",
        kind: `budget.${how === "commit" ? "committed" : how === "release" ? "released" : "held"}`,
        summary: `${r.amount ? money(r.amount, r.currency ?? "USD") : "1 action"} ${how === "commit" ? "committed to" : how === "release" ? "released from" : "still held in"} ${r.scopeKey} (${r.periodKey}): ${reason}`,
        payload: { reservationId: r.id, executionId, scope: r.scopeKey, amount: r.amount },
        runId: r.runId,
      });
    }
  }

  async usable(tx: Tx, authorityIds: string[], now: Date) {
    if (authorityIds.length === 0) return { ok: true as const };
    const rows = await tx.select().from(authorities).where(inArray(authorities.id, authorityIds));
    for (const a of rows) {
      if (a.status !== "ACTIVE") return { ok: false as const, reason: `Authority “${a.name}” was ${a.status.toLowerCase()}${a.statusReason ? `: ${a.statusReason}` : ""}` };
      if (a.expiresAt && a.expiresAt <= now) return { ok: false as const, reason: `Authority “${a.name}” expired on ${a.expiresAt.toISOString().slice(0, 10)}` };
    }
    if (rows.length !== authorityIds.length) return { ok: false as const, reason: "An authority behind this action no longer exists" };
    return { ok: true as const };
  }
}

/** What an authority looked like at decision time (for reconstruction). */
function snapshot(a: AuthorityRow) {
  return {
    id: a.id,
    name: a.name,
    version: a.version,
    status: a.status,
    workflowIds: a.workflowIds,
    actions: a.actions,
    counterpartyRule: a.counterpartyRule,
    counterparties: a.counterparties,
    deniedCounterparties: a.deniedCounterparties,
    currencies: a.currencies,
    perTransactionMax: a.perTransactionMax,
    budgetAmount: a.budgetAmount,
    budgetPeriod: a.budgetPeriod,
    maxCount: a.maxCount,
    countPeriod: a.countPeriod,
    validFrom: a.validFrom,
    expiresAt: a.expiresAt,
    purposeScope: a.purposeScope,
    intelligencePolicy: a.intelligencePolicy,
  };
}
