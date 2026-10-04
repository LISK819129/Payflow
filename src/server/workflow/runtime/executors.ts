import { and, eq, or, sql } from "drizzle-orm";
import { appendAudit } from "../../audit/audit";
import { approvals, workflows } from "../../db/schema";
import { compareDecimal } from "../dsl/decimal";
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
    return { kind: "wait", waitFor: "approval", explanation: `Waiting for approval: ${cfg.reason}` };
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
};

export function notImplemented(type: string): NodeResult {
  return { kind: "error", code: "NOT_IMPLEMENTED", message: `${type} has no executor`, explanation: `${type} cannot run yet` };
}
