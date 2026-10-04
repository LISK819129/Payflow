import { SPEC_BY_TYPE, type GraphNode } from "../workflow/dsl/nodes";
import { resolveRef } from "../workflow/dsl/expression";
import { compareDecimal } from "../workflow/dsl/decimal";
import type { RunContext, RunRow, StepRow } from "../workflow/runtime/types";
import type { ActionIntent, ActionKind, GateEvidence } from "./types";

/**
 * Turns an action node plus the run's data into a fully resolved ActionIntent,
 * or refuses. Refusal is the default: a missing, malformed, non-positive or
 * over-precise amount, an unknown currency, a bad email or id, or a path with
 * no passed gate all stop here — PayPal is never called.
 */

export type Prepared = { ok: true; intent: ActionIntent } | { ok: false; code: string; message: string };

const MONEY_VALUE = /^\d{1,10}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,24}$/;
const PAYPAL_ID = /^[A-Za-z0-9-]{6,40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function money(v: unknown): { value: string; currency: string } | string {
  if (!v || typeof v !== "object") return "no amount";
  const o = v as Record<string, unknown>;
  const value = typeof o.value === "string" ? o.value.trim() : null;
  const currency = typeof o.currency_code === "string" ? o.currency_code : typeof o.currency === "string" ? o.currency : null;
  if (!value) return "amount has no value";
  if (!currency) return "amount has no currency";
  if (!MONEY_VALUE.test(value)) return `amount "${value}" is not an exact decimal with at most 2 places`;
  if (!CURRENCY.test(currency)) return `currency "${currency}" is not an ISO currency code`;
  if (compareDecimal(value, "0") <= 0) return "amount must be greater than zero";
  return { value, currency };
}

function text(ctx: RunContext, ref: string | undefined): string | null {
  if (!ref) return null;
  const v = resolveRef(ctx as unknown as Record<string, unknown>, ref);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Gates actually passed on this run's executed path. The validator already
 * guarantees statically that a gate precedes every money node; this re-checks
 * what really happened, so a bug elsewhere can never let an ungated action run.
 */
export function gatesPassed(steps: StepRow[]): GateEvidence[] {
  return steps
    .filter((s) => s.status === "OK" && ((SPEC_BY_TYPE[s.nodeType]?.isPolicy && s.port === "pass") || (s.nodeType === "control.approval" && s.port === "approved")))
    .map((s) => ({ nodeId: s.nodeId, nodeType: s.nodeType, port: s.port!, explanation: s.explanation }));
}

export function prepareIntent(input: { node: GraphNode; ctx: RunContext; run: RunRow; steps: StepRow[] }): Prepared {
  const { node, ctx, run, steps } = input;
  const c = node.config as Record<string, unknown>;
  const spec = SPEC_BY_TYPE[node.type];
  const kind = node.type as ActionKind;
  const refuse = (code: string, message: string): Prepared => ({ ok: false, code, message });

  const gates = gatesPassed(steps);
  if ((spec.movesMoney || spec.external) && gates.length === 0) {
    return refuse("NO_AUTHORIZATION", "No policy gate passed and no approval was granted on this run's path; refusing to act");
  }

  const base = {
    kind,
    idempotencyKey: `pf:${run.id}:${node.id}`,
    workspaceId: run.workspaceId,
    runId: run.id,
    nodeId: node.id,
    movesMoney: !!spec.movesMoney,
    external: !!spec.external,
    authorization: { gates },
    provenance: "REAL_PAYPAL_SANDBOX" as const,
  };
  const amountAt = (ref: unknown) => money(resolveRef(ctx as unknown as Record<string, unknown>, String(ref)));

  switch (kind) {
    case "paypal.payout": {
      const amount = amountAt(c.amountRef);
      if (typeof amount === "string") return refuse("BAD_AMOUNT", `Payout: ${amount}`);
      const receiver = text(ctx, c.receiverRef as string);
      if (!receiver || !EMAIL.test(receiver)) return refuse("BAD_RECEIVER", `Payout: receiver "${receiver ?? ""}" is not an email address`);
      return { ok: true, intent: { ...base, amount, counterparty: receiver.toLowerCase(), target: null, params: { note: String(c.note ?? "") } } };
    }
    case "paypal.refund": {
      const amount = amountAt(c.amountRef);
      if (typeof amount === "string") return refuse("BAD_AMOUNT", `Refund: ${amount}`);
      const captureId = text(ctx, c.captureIdRef as string);
      if (!captureId || !PAYPAL_ID.test(captureId)) return refuse("BAD_TARGET", `Refund: "${captureId ?? ""}" is not a PayPal capture id`);
      return { ok: true, intent: { ...base, amount, counterparty: null, target: { type: "capture", id: captureId }, params: { note: String(c.note ?? "") } } };
    }
    case "paypal.order_capture": {
      const amount = amountAt(c.amountRef);
      if (typeof amount === "string") return refuse("BAD_AMOUNT", `Capture: ${amount}`);
      const orderId = text(ctx, c.orderIdRef as string);
      if (!orderId || !PAYPAL_ID.test(orderId)) return refuse("BAD_TARGET", `Capture: "${orderId ?? ""}" is not a PayPal order id`);
      return { ok: true, intent: { ...base, amount, counterparty: null, target: { type: "order", id: orderId }, params: {} } };
    }
    case "paypal.invoice_send": {
      const amount = amountAt(c.amountRef);
      if (typeof amount === "string") return refuse("BAD_AMOUNT", `Invoice: ${amount}`);
      const recipient = text(ctx, c.recipientRef as string);
      if (!recipient || !EMAIL.test(recipient)) return refuse("BAD_RECIPIENT", `Invoice: recipient "${recipient ?? ""}" is not an email address`);
      const dueDate = text(ctx, c.dueDateRef as string | undefined);
      if (c.dueDateRef && (!dueDate || !ISO_DATE.test(dueDate))) return refuse("BAD_DUE_DATE", `Invoice: due date "${dueDate ?? ""}" is not YYYY-MM-DD`);
      return {
        ok: true,
        intent: { ...base, amount, counterparty: recipient.toLowerCase(), target: null, params: { description: String(c.description), dueDate: dueDate ?? undefined, note: c.note as string | undefined } },
      };
    }
    case "paypal.invoice_remind": {
      const invoiceId = text(ctx, c.invoiceIdRef as string);
      if (!invoiceId || !PAYPAL_ID.test(invoiceId)) return refuse("BAD_TARGET", `Reminder: "${invoiceId ?? ""}" is not a PayPal invoice id`);
      return { ok: true, intent: { ...base, amount: null, counterparty: null, target: { type: "invoice", id: invoiceId }, params: { subject: c.subject, note: text(ctx, c.noteRef as string | undefined) ?? undefined } } };
    }
    case "paypal.fetch": {
      const id = text(ctx, c.idRef as string);
      if (!id || !PAYPAL_ID.test(id)) return refuse("BAD_TARGET", `Fetch: "${id ?? ""}" is not a PayPal id`);
      return { ok: true, intent: { ...base, amount: null, counterparty: null, target: { type: String(c.resource), id }, params: {} } };
    }
    case "paypal.transaction_search": {
      return { ok: true, intent: { ...base, amount: null, counterparty: null, target: null, params: { days: c.days, counterparty: text(ctx, c.counterpartyRef as string | undefined) ?? undefined } } };
    }
    case "ledger.reconcile": {
      const amount = amountAt(c.paymentRef);
      if (typeof amount === "string") return refuse("BAD_AMOUNT", `Reconcile: ${amount}`);
      const invoiceId = text(ctx, c.invoiceIdRef as string);
      if (!invoiceId || !PAYPAL_ID.test(invoiceId)) return refuse("BAD_TARGET", `Reconcile: "${invoiceId ?? ""}" is not a PayPal invoice id`);
      return { ok: true, intent: { ...base, amount, counterparty: null, target: { type: "invoice", id: invoiceId }, params: { paymentRef: text(ctx, "trigger.paymentId") ?? text(ctx, "trigger.resourceId") ?? undefined } } };
    }
    default:
      return refuse("NOT_AN_ACTION", `${node.type} is not an action node`);
  }
}

export function isActionNode(type: string) {
  return type.startsWith("paypal.") || type === "ledger.reconcile";
}
