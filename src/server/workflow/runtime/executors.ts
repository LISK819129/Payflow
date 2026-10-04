import { and, eq, or, sql } from "drizzle-orm";
import { appendAudit } from "../../audit/audit";
import { approvals, budgetReservations, workflows } from "../../db/schema";
import { money } from "../../authority/evaluate";
import { lockScope, usageFor, withLedgerLock } from "../../authority/ledger";
import { periodWindow, type Period } from "../../authority/periods";
import { addDecimal, compareDecimal } from "../dsl/decimal";
import { describeExpr, evaluate, ExpressionError, resolveRef, type Expr } from "../dsl/expression";
import type { Money } from "../dsl/nodes";
import type { Executor, NodeResult } from "./types";

type Cfg<T> = T;

/** Reads a money-shaped value ({value, currency_code|currency}) or reports why it can't. */
function readMoney(v: unknown): { value: string; currency: string } | string {
  if (!v || typeof v !== "object") return "no amount";
  const o = v as Record<string, unknown>;
  const value = typeof o.value === "string" ? o.value : typeof o.value === "number" ? String(o.value) : null;
  const currency = typeof o.currency_code === "string" ? o.currency_code : typeof o.currency === "string" ? o.currency : null;
  if (!value || !currency) return "amount is incomplete";
  try {
    compareDecimal(value, "0");
  } catch {
    return `amount "${value}" is not a decimal`;
  }
  return { value, currency };
}

const fmt = (m: { value: string; currency: string }) => `${m.value} ${m.currency}`;

function ctxRecord(ctx: Parameters<Executor>[0]["ctx"]) {
  return ctx as unknown as Record<string, unknown>;
}

const trigger: Executor = async ({ run }) => ({
  kind: "next",
  port: "next",
  explanation:
    run.triggerKind === "paypal_event"
      ? `Started by verified PayPal event ${(run.triggerPayload as { eventType?: string }).eventType ?? ""}`.trim()
      : run.triggerKind === "schedule"
        ? "Started by schedule"
        : "Started manually with a user-provided payload",
});

const condition: Executor = async ({ node, ctx }) => {
  const { expr } = node.config as Cfg<{ expr: Expr }>;
  try {
    const result = evaluate(expr, ctxRecord(ctx));
    return { kind: "next", port: result ? "true" : "false", output: { result }, explanation: `${describeExpr(expr)} → ${result ? "true" : "false"}` };
  } catch (e) {
    if (e instanceof ExpressionError) {
      return { kind: "error", code: "EXPRESSION", message: e.message, explanation: `Could not evaluate ${describeExpr(expr)}: ${e.message}` };
    }
    throw e;
  }
};

const amountLimit: Executor = async ({ node, ctx }) => {
  const { amountRef, max, comparison = "lte" } = node.config as Cfg<{ amountRef: string; max: Money; comparison?: "lte" | "lt" }>;
  const amount = readMoney(resolveRef(ctxRecord(ctx), amountRef));
  if (typeof amount === "string") return { kind: "error", code: "NO_AMOUNT", message: amount, explanation: `Amount limit: ${amount} at ${amountRef}` };
  const limit = { value: max.value, currency: max.currency };
  if (amount.currency !== limit.currency) {
    return { kind: "next", port: "block", output: { amount, limit, comparison, reason: "currency" }, explanation: `Blocked: amount is in ${amount.currency}, limit is defined in ${limit.currency}` };
  }
  const c = compareDecimal(amount.value, limit.value);
  const ok = comparison === "lt" ? c < 0 : c <= 0;
  const rule = comparison === "lt" ? `below ${fmt(limit)}` : `at or below ${fmt(limit)}`;
  return {
    kind: "next",
    port: ok ? "pass" : "block",
    output: { amount, limit, comparison, passed: ok },
    explanation: ok ? `${fmt(amount)} is ${rule}` : `Blocked: ${fmt(amount)} is not ${rule}`,
  };
};

const currency: Executor = async ({ node, ctx }) => {
  const { amountRef, allowed } = node.config as Cfg<{ amountRef: string; allowed: string[] }>;
  const amount = readMoney(resolveRef(ctxRecord(ctx), amountRef));
  if (typeof amount === "string") return { kind: "error", code: "NO_AMOUNT", message: amount, explanation: `Currency check: ${amount} at ${amountRef}` };
  const ok = allowed.includes(amount.currency);
  return {
    kind: "next",
    port: ok ? "pass" : "block",
    output: { currency: amount.currency, allowed, passed: ok },
    explanation: ok ? `Currency ${amount.currency} is allowed` : `Blocked: currency ${amount.currency} is not one of ${allowed.join(", ")}`,
  };
};

const counterparty: Executor = async ({ node, ctx }) => {
  const { ref, allowed } = node.config as Cfg<{ ref: string; allowed: string[] }>;
  const v = resolveRef(ctxRecord(ctx), ref);
  if (typeof v !== "string" || v.length === 0) {
    return { kind: "error", code: "NO_COUNTERPARTY", message: `no counterparty at ${ref}`, explanation: `Counterparty check: nothing at ${ref}` };
  }
  const ok = allowed.some((a) => a.toLowerCase() === v.toLowerCase());
  return {
    kind: "next",
    port: ok ? "pass" : "block",
    output: { counterparty: v, passed: ok },
    explanation: ok ? `${v} is an approved counterparty` : `Blocked: ${v} is not an approved counterparty`,
  };
};

const approval: Executor = async ({ tx, node, ctx, run, now }) => {
  const cfg = node.config as Cfg<{ reason: string; amountRef?: string; counterpartyRef?: string; expiresAfterHours?: number }>;
  const [existing] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, run.id), eq(approvals.nodeId, node.id)))
    .limit(1);

  if (!existing) {
    const amount = cfg.amountRef ? readMoney(resolveRef(ctxRecord(ctx), cfg.amountRef)) : null;
    const party = cfg.counterpartyRef ? resolveRef(ctxRecord(ctx), cfg.counterpartyRef) : null;
    // Evidence the approver sees: every decision recorded so far in this run.
    const evidence = Object.entries(ctx.nodes).map(([id, n]) => ({ nodeId: id, port: n.port }));
    await tx.insert(approvals).values({
      workspaceId: run.workspaceId,
      runId: run.id,
      nodeId: node.id,
      reason: cfg.reason,
      summary: {
        amount: amount && typeof amount !== "string" ? amount : null,
        counterparty: typeof party === "string" ? party : null,
        evidence,
      },
      expiresAt: cfg.expiresAfterHours ? new Date(now.getTime() + cfg.expiresAfterHours * 3_600_000) : null,
    });
    const expiresAt = cfg.expiresAfterHours ? new Date(now.getTime() + cfg.expiresAfterHours * 3_600_000) : undefined;
    return { kind: "wait", waitFor: "approval", wakeAt: expiresAt, explanation: `Waiting for approval: ${cfg.reason}` };
  }

  if (existing.status === "PENDING") {
    if (existing.expiresAt && existing.expiresAt <= now) {
      await tx.update(approvals).set({ status: "EXPIRED", decidedAt: now }).where(eq(approvals.id, existing.id));
      return { kind: "next", port: "rejected", output: { decision: "EXPIRED" }, explanation: "Approval expired without a decision; treated as rejected" };
    }
    return { kind: "wait", waitFor: "approval", explanation: `Waiting for approval: ${cfg.reason}` };
  }
  const approved = existing.status === "APPROVED";
  return {
    kind: "next",
    port: approved ? "approved" : "rejected",
    output: { decision: existing.status, decidedBy: existing.decidedBy, note: existing.note },
    explanation: approved ? "Approved by a person" : existing.status === "EXPIRED" ? "Approval expired; treated as rejected" : "Rejected by a person",
  };
};

const delay: Executor = async ({ node, ctx, waiting, now }) => {
  const cfg = node.config as Cfg<{ minutes?: number; untilRef?: string; offsetDays?: number }>;
  const prior = (waiting?.output as { wakeAt?: string } | null)?.wakeAt;
  let wakeAt: Date;
  if (prior) {
    wakeAt = new Date(prior);
  } else if (cfg.untilRef) {
    const raw = resolveRef(ctxRecord(ctx), cfg.untilRef);
    const base = typeof raw === "string" ? new Date(raw) : null;
    if (!base || Number.isNaN(base.getTime())) {
      return { kind: "error", code: "NO_DATE", message: `no date at ${cfg.untilRef}`, explanation: `Delay: ${cfg.untilRef} is not a date` };
    }
    wakeAt = new Date(base.getTime() + (cfg.offsetDays ?? 0) * 86_400_000 + (cfg.minutes ?? 0) * 60_000);
  } else {
    wakeAt = new Date(now.getTime() + (cfg.minutes ?? 0) * 60_000);
  }
  if (wakeAt <= now) return { kind: "next", port: "elapsed", output: { wakeAt: wakeAt.toISOString() }, explanation: `Waited until ${wakeAt.toISOString()}` };
  return { kind: "wait", waitFor: "timer", wakeAt, output: { wakeAt: wakeAt.toISOString() }, explanation: `Waiting until ${wakeAt.toISOString()}` };
};

const freeze: Executor = async ({ tx, node, run, workflow, now }) => {
  const cfg = node.config as Cfg<{ reason: string; includeDependents?: boolean }>;
  const targets = await tx
    .update(workflows)
    .set({ state: "FROZEN", frozenReason: cfg.reason, frozenAt: now, frozenByRunId: run.id, updatedAt: now })
    .where(
      and(
        eq(workflows.workspaceId, run.workspaceId),
        cfg.includeDependents === false
          ? eq(workflows.id, workflow.id)
          : or(eq(workflows.id, workflow.id), sql`${workflows.dependsOn} @> ${JSON.stringify([workflow.id])}::jsonb`),
      ),
    )
    .returning({ id: workflows.id, name: workflows.name });
  for (const t of targets) {
    await appendAudit(tx, {
      workspaceId: run.workspaceId,
      actor: "system",
      kind: "workflow.frozen",
      summary: `Workflow "${t.name}" frozen: ${cfg.reason}`,
      payload: { byRun: run.id, byNode: node.id },
      workflowId: t.id,
      runId: run.id,
    });
  }
  return { kind: "next", port: "next", output: { frozen: targets.map((t) => t.id) }, explanation: `Froze ${targets.length} workflow(s): ${cfg.reason}` };
};

/**
 * Workflow-level budget: CHECK and RESERVE under an advisory lock on the budget
 * key, so two runs racing for the last of a budget cannot both pass. The
 * reservation is settled when the run ends (commit if a PayPal action on the
 * run succeeded, release if none did, hold if an outcome is unknown).
 */
const budget: Executor = async ({ tx, node, ctx, run, now }) => {
  const cfg = node.config as Cfg<{ amountRef: string; budget: Money; period: Period; budgetKey: string }>;
  const scopeKey = `budget:${cfg.budgetKey}`;
  const amount = readMoney(resolveRef(ctxRecord(ctx), cfg.amountRef));
  if (typeof amount === "string") return { kind: "error", code: "NO_AMOUNT", message: amount, explanation: `Budget: ${amount} at ${cfg.amountRef}` };
  const limit = { value: cfg.budget.value, currency: cfg.budget.currency };
  const w = periodWindow(cfg.period, now);
  if (amount.currency !== limit.currency) {
    return { kind: "next", port: "block", output: { reason: "currency" }, explanation: `Blocked: amount is in ${amount.currency}; the “${cfg.budgetKey}” budget is in ${limit.currency}` };
  }
  const out = await withLedgerLock(tx, async (sp) => {
    const [mine] = await sp.select().from(budgetReservations).where(and(eq(budgetReservations.runId, run.id), eq(budgetReservations.nodeId, node.id), eq(budgetReservations.scopeKey, scopeKey)));
    if (mine) return { already: mine };
    await lockScope(sp, run.workspaceId, scopeKey);
    return { usage: await usageFor(sp, run.workspaceId, scopeKey, w) };
  });
  if (out === "unavailable") {
    return { kind: "next", port: "block", output: { reason: "unavailable" }, explanation: `Blocked: the “${cfg.budgetKey}” budget could not be read, so nothing is spent against it` };
  }
  if ("already" in out && out.already) return { kind: "next", port: "pass", output: { reservationId: out.already.id }, explanation: `Already reserved ${money(amount.value, amount.currency)}` };
  const usage = out.usage!;
  const used = addDecimal(usage.committed, usage.reserved);
  const after = addDecimal(used, amount.value);
  const snapshot = { budgetKey: cfg.budgetKey, limit: limit.value, currency: limit.currency, period: cfg.period, periodKey: w.key, periodLabel: w.label, committed: usage.committed, reserved: usage.reserved, request: amount.value, after };
  if (compareDecimal(after, limit.value) > 0) {
    return {
      kind: "next",
      port: "block",
      output: { ...snapshot, passed: false },
      explanation: `Blocked: ${money(amount.value, amount.currency)} would bring ${w.label} to ${money(after, limit.currency)}, over the ${money(limit.value, limit.currency)} “${cfg.budgetKey}” budget`,
    };
  }
  const [r] = await tx
    .insert(budgetReservations)
    .values({ workspaceId: run.workspaceId, scopeKey, periodKey: w.key, amount: amount.value, currency: amount.currency, runId: run.id, nodeId: node.id, createdAt: now })
    .returning({ id: budgetReservations.id });
  await appendAudit(tx, {
    workspaceId: run.workspaceId,
    actor: "system",
    kind: "budget.reserved",
    summary: `Reserved ${money(amount.value, amount.currency)} of the “${cfg.budgetKey}” budget for ${w.label}: ${money(after, limit.currency)} of ${money(limit.value, limit.currency)}`,
    payload: { reservationId: r.id, ...snapshot },
    workflowId: run.workflowId,
    runId: run.id,
  });
  return {
    kind: "next",
    port: "pass",
    output: { ...snapshot, passed: true, reservationId: r.id },
    explanation: `Reserved ${money(amount.value, amount.currency)}: ${w.label} ${money(after, limit.currency)} of ${money(limit.value, limit.currency)}`,
  };
};

/** Workflow-level frequency limit: same CHECK → RESERVE discipline, counting passes. */
const frequency: Executor = async ({ tx, node, run, now }) => {
  const cfg = node.config as Cfg<{ max: number; period: Period; key: string }>;
  const scopeKey = `frequency:${cfg.key}`;
  const w = periodWindow(cfg.period, now);
  const out = await withLedgerLock(tx, async (sp) => {
    const [mine] = await sp.select().from(budgetReservations).where(and(eq(budgetReservations.runId, run.id), eq(budgetReservations.nodeId, node.id), eq(budgetReservations.scopeKey, scopeKey)));
    if (mine) return { already: mine };
    await lockScope(sp, run.workspaceId, scopeKey);
    return { usage: await usageFor(sp, run.workspaceId, scopeKey, w) };
  });
  if (out === "unavailable") return { kind: "next", port: "block", output: { reason: "unavailable" }, explanation: `Blocked: the “${cfg.key}” counter could not be read` };
  if ("already" in out && out.already) return { kind: "next", port: "pass", output: { reservationId: out.already.id }, explanation: "Already counted" };
  const after = out.usage!.count + 1;
  const snapshot = { key: cfg.key, max: cfg.max, period: cfg.period, periodKey: w.key, periodLabel: w.label, used: out.usage!.count, after };
  if (after > cfg.max) {
    return { kind: "next", port: "block", output: { ...snapshot, passed: false }, explanation: `Blocked: this would be ${after} this ${cfg.period}; “${cfg.key}” allows ${cfg.max}` };
  }
  const [r] = await tx
    .insert(budgetReservations)
    .values({ workspaceId: run.workspaceId, scopeKey, periodKey: w.key, runId: run.id, nodeId: node.id, createdAt: now })
    .returning({ id: budgetReservations.id });
  await appendAudit(tx, {
    workspaceId: run.workspaceId,
    actor: "system",
    kind: "budget.reserved",
    summary: `Counted 1 of ${cfg.max} “${cfg.key}” for ${w.label} (${after} of ${cfg.max})`,
    payload: { reservationId: r.id, ...snapshot },
    workflowId: run.workflowId,
    runId: run.id,
  });
  return { kind: "next", port: "pass", output: { ...snapshot, passed: true, reservationId: r.id }, explanation: `${after} of ${cfg.max} this ${cfg.period} (${w.label})` };
};

const terminal: Executor = async ({ node }) => {
  const cfg = node.config as Cfg<{ outcome: "completed" | "blocked" | "rejected" | "needs_review"; message: string }>;
  return { kind: "end", outcome: cfg.outcome, explanation: cfg.message };
};

/** Executors that exist. A node type missing here cannot be activated (see RUNTIME_PHASE). */
export const EXECUTORS: Record<string, Executor> = {
  "trigger.manual": trigger,
  "trigger.paypal_event": trigger,
  "trigger.schedule": trigger,
  "control.condition": condition,
  "control.approval": approval,
  "control.delay": delay,
  "control.freeze": freeze,
  "control.terminal": terminal,
  "policy.amount_limit": amountLimit,
  "policy.currency": currency,
  "policy.counterparty": counterparty,
  "policy.budget": budget,
  "policy.frequency": frequency,
};

export function notImplemented(type: string): NodeResult {
  return { kind: "error", code: "NOT_IMPLEMENTED", message: `${type} has no executor`, explanation: `${type} cannot run yet` };
}
