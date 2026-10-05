import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { reconciliations } from "../db/schema";
import { compareDecimal } from "../workflow/dsl/decimal";
import { PayPalApiError } from "../paypal/errors";
import * as pp from "../paypal/operations";
import { assertLiveWrite } from "../runtime/mode";
import type { ActionGateway, ActionIntent, ActionOutcome, GatewayContext } from "./types";

function failure(err: unknown): ActionOutcome {
  if (err instanceof PayPalApiError) {
    // 4xx is PayPal's definitive answer; network errors and 5xx may not have reached PayPal.
    const retryable = err.status === 0 || err.status >= 500 || err.status === 429;
    // PayPal's first detail names the actual business reason (e.g. CAPTURE_FULLY_REFUNDED); the top-level name is generic.
    const first = Array.isArray(err.details) ? (err.details[0] as { issue?: string; description?: string } | undefined) : undefined;
    return {
      status: "failed",
      retryable,
      error: { code: first?.issue ?? err.code, message: first?.description ?? err.message, status: err.status, debugId: err.debugId ?? null, details: err.details },
    };
  }
  return { status: "failed", retryable: true, error: { code: "UNEXPECTED", message: (err as Error).message } };
}

const req = (intent: ActionIntent, step?: string) => (step ? `${intent.idempotencyKey}:${step}` : intent.idempotencyKey);

/** Executes intents directly against the PayPal Sandbox. */
export class DirectPayPalGateway implements ActionGateway {
  readonly name = "paypal-direct";

  async execute(intent: ActionIntent, ctx: GatewayContext): Promise<ActionOutcome> {
    // Outside the try: a sandboxed caller gets an exception, never a "failed" outcome that looks like PayPal's answer.
    assertLiveWrite(`PayPal ${intent.kind}`);
    try {
      switch (intent.kind) {
        case "paypal.refund": {
          const r = await pp.refundCapture({ captureId: intent.target!.id, amount: intent.amount!, note: String(intent.params.note ?? ""), requestId: req(intent) });
          return { status: "succeeded", paypalRefs: [r.refundId, intent.target!.id], paypalStatus: r.status, debugId: r.debugId ?? null, result: { refundId: r.refundId, amount: r.amount, captureId: intent.target!.id } };
        }
        case "paypal.payout": {
          const r = await pp.createPayout({ receiver: intent.counterparty!, amount: intent.amount!, note: String(intent.params.note ?? ""), requestId: req(intent) });
          return { status: "succeeded", paypalRefs: [r.payoutBatchId], paypalStatus: r.status, debugId: r.debugId ?? null, result: { payoutBatchId: r.payoutBatchId, receiver: intent.counterparty, amount: intent.amount, recoveredAfterLostReply: r.recovered } };
        }
        case "paypal.order_capture": {
          // Capture only what was expected: PayPal's order must match the amount the workflow approved.
          const order = await pp.getOrder(intent.target!.id);
          // On a retry, COMPLETED may be our own earlier capture whose reply was lost: re-send the
          // capture with the same PayPal-Request-Id and PayPal replays its original answer.
          if (order.status === "COMPLETED" && ctx.attempt === 1) {
            return { status: "failed", retryable: false, error: { code: "ORDER_ALREADY_CAPTURED", message: `Order ${order.id} is already captured`, debugId: order.debugId ?? null } };
          }
          if (order.amount.currency !== intent.amount!.currency || compareDecimal(order.amount.value, intent.amount!.value) !== 0) {
            return {
              status: "failed",
              retryable: false,
              error: { code: "AMOUNT_MISMATCH", message: `Order is ${order.amount.value} ${order.amount.currency}; expected ${intent.amount!.value} ${intent.amount!.currency}`, debugId: order.debugId ?? null },
            };
          }
          const r = await pp.captureOrder({ orderId: intent.target!.id, requestId: req(intent) });
          return {
            status: "succeeded",
            paypalRefs: [r.orderId, ...(r.captureId ? [r.captureId] : [])],
            paypalStatus: r.captureStatus ?? r.status,
            debugId: r.debugId ?? null,
            result: { orderId: r.orderId, captureId: r.captureId, amount: r.amount },
          };
        }
        case "paypal.invoice_send": {
          // Two calls. The draft's id is checkpointed before sending, so a replay sends the same invoice.
          let invoiceId = (ctx.previous?.invoiceId as string | undefined) ?? null;
          if (!invoiceId) {
            const draft = await pp.createInvoiceDraft({
              recipientEmail: intent.counterparty!,
              amount: intent.amount!,
              description: String(intent.params.description ?? "Services"),
              dueDate: (intent.params.dueDate as string | undefined) ?? undefined,
              note: (intent.params.note as string | undefined) ?? undefined,
              requestId: req(intent, "create"),
            });
            invoiceId = draft.invoiceId;
            await ctx.checkpoint([invoiceId], { invoiceId });
          }
          await pp.sendInvoice({ invoiceId, requestId: req(intent, "send") });
          const inv = await pp.getInvoice(invoiceId);
          return { status: "succeeded", paypalRefs: [invoiceId], paypalStatus: inv.status, debugId: inv.debugId ?? null, result: { invoiceId, number: inv.number, status: inv.status, amount: inv.amount, recipient: intent.counterparty } };
        }
        case "paypal.invoice_remind": {
          const r = await pp.remindInvoice({ invoiceId: intent.target!.id, subject: intent.params.subject as string | undefined, note: intent.params.note as string | undefined, requestId: req(intent) });
          // PayPal answers 204 with no body; the invoice's own status is what PayPal actually reports afterwards.
          const inv = await pp.getInvoice(intent.target!.id);
          return {
            status: "succeeded",
            paypalRefs: [intent.target!.id],
            paypalStatus: inv.status,
            debugId: r.debugId ?? null,
            result: { invoiceId: intent.target!.id, reminderAccepted: true, invoiceStatus: inv.status, number: inv.number },
          };
        }
        case "paypal.fetch": {
          const id = intent.target!.id;
          const r =
            intent.target!.type === "capture"
              ? await pp.getCapture(id)
              : intent.target!.type === "order"
                ? await pp.getOrder(id)
                : intent.target!.type === "invoice"
                  ? await pp.getInvoice(id)
                  : intent.target!.type === "dispute"
                    ? await pp.getDispute(id)
                    : await pp.getPayoutItem(id);
          const { debugId, ...data } = r as typeof r & { debugId?: string };
          return { status: "succeeded", paypalRefs: [id], paypalStatus: (data as { status?: string }).status ?? null, debugId: debugId ?? null, result: data };
        }
        case "paypal.transaction_search": {
          const r = await pp.searchTransactions({ days: Number(intent.params.days ?? 7) });
          const who = (intent.params.counterparty as string | undefined)?.toLowerCase();
          const rows = who ? r.rows.filter((x) => x.payerEmail?.toLowerCase() === who) : r.rows;
          return { status: "succeeded", paypalRefs: [], paypalStatus: null, debugId: r.debugId ?? null, result: { count: rows.length, rows: rows.slice(0, 50), days: intent.params.days } };
        }
        case "ledger.reconcile": {
          const inv = await pp.getInvoice(intent.target!.id);
          const paid = ["PAID", "MARKED_AS_PAID"].includes(inv.status);
          if (!paid) return { status: "failed", retryable: false, error: { code: "INVOICE_NOT_PAID", message: `Invoice ${inv.number ?? inv.id} is ${inv.status}, not paid`, debugId: inv.debugId ?? null } };
          if (inv.amount.currency !== intent.amount!.currency || compareDecimal(inv.amount.value, intent.amount!.value) !== 0) {
            return {
              status: "failed",
              retryable: false,
              error: { code: "AMOUNT_MISMATCH", message: `Invoice is ${inv.amount.value} ${inv.amount.currency}; payment is ${intent.amount!.value} ${intent.amount!.currency}`, debugId: inv.debugId ?? null },
            };
          }
          await db()
            .insert(reconciliations)
            .values({
              workspaceId: intent.workspaceId,
              runId: intent.runId,
              invoiceId: inv.id,
              invoiceStatus: inv.status,
              invoiceAmount: inv.amount.value,
              paymentAmount: intent.amount!.value,
              currency: inv.amount.currency,
              paymentRef: (intent.params.paymentRef as string | undefined) ?? null,
            })
            .onConflictDoNothing();
          const [row] = await db().select().from(reconciliations).where(and(eq(reconciliations.invoiceId, inv.id), eq(reconciliations.runId, intent.runId)));
          const paymentRef = intent.params.paymentRef as string | undefined;
          return { status: "succeeded", paypalRefs: paymentRef ? [inv.id, paymentRef] : [inv.id], paypalStatus: inv.status, debugId: inv.debugId ?? null, result: { reconciliationId: row.id, invoiceId: inv.id, number: inv.number, amount: inv.amount } };
        }
      }
    } catch (err) {
      return failure(err);
    }
  }
}

const direct = new DirectPayPalGateway();
const g = globalThis as unknown as { __gatewayOverride?: ActionGateway };

/**
 * Chooses the gateway for an intent. Every kind goes straight to PayPal today;
 * this is the single place a protected kind would be routed through an extra
 * authorization layer. Tests substitute a fake with `setGatewayForTests`.
 */
export function gatewayFor(intent: ActionIntent): ActionGateway {
  return g.__gatewayOverride ?? routed[intent.kind] ?? direct;
}

/** Kinds routed through another gateway. Empty until GatePal exists. */
const routed: Partial<Record<ActionIntent["kind"], ActionGateway>> = {};

export function setGatewayForTests(gateway: ActionGateway | null) {
  g.__gatewayOverride = gateway ?? undefined;
}
