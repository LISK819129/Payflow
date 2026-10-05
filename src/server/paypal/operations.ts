import { paypal } from "./client";
import { PayPalApiError } from "./errors";
import { assertLiveWrite } from "../runtime/mode";
import { paypalSdk, sdkCall } from "./sdk";

/**
 * Typed PayPal operations used by action nodes. Every POST carries the
 * caller's idempotency key as PayPal-Request-Id; amounts are exact decimal
 * strings with explicit currency. Nothing here decides whether an action is
 * allowed — that happened before an intent reached the gateway.
 */

export type Money = { value: string; currency: string };

// ── Payments / Orders (official SDK) ─────────────────────────────────────────

export async function getCapture(captureId: string) {
  const r = await sdkCall("Get capture", () => paypalSdk().payments.getCapturedPayment({ captureId }));
  const c = r.data as { id?: string; status?: string; amount?: { value?: string; currencyCode?: string } };
  return { id: c.id!, status: c.status ?? "UNKNOWN", amount: { value: c.amount?.value ?? "", currency: c.amount?.currencyCode ?? "" }, debugId: r.debugId };
}

export async function refundCapture(input: { captureId: string; amount: Money; note: string; requestId: string }) {
  assertLiveWrite("PayPal refund");
  const r = await sdkCall("Refund capture", () =>
    paypalSdk().payments.refundCapturedPayment({
      captureId: input.captureId,
      paypalRequestId: input.requestId,
      prefer: "return=representation",
      body: { amount: { value: input.amount.value, currencyCode: input.amount.currency }, noteToPayer: input.note.slice(0, 255) },
    }),
  );
  const d = r.data as { id?: string; status?: string; amount?: { value?: string; currencyCode?: string } };
  return { refundId: d.id!, status: d.status ?? "UNKNOWN", amount: { value: d.amount?.value ?? input.amount.value, currency: d.amount?.currencyCode ?? input.amount.currency }, debugId: r.debugId };
}

export async function getOrder(orderId: string) {
  const r = await sdkCall("Get order", () => paypalSdk().orders.getOrder({ id: orderId }));
  const o = r.data as { id?: string; status?: string; purchaseUnits?: { amount?: { value?: string; currencyCode?: string } }[] };
  const a = o.purchaseUnits?.[0]?.amount;
  return { id: o.id!, status: o.status ?? "UNKNOWN", amount: { value: a?.value ?? "", currency: a?.currencyCode ?? "" }, debugId: r.debugId };
}

export async function captureOrder(input: { orderId: string; requestId: string }) {
  assertLiveWrite("PayPal order capture");
  const r = await sdkCall("Capture order", () => paypalSdk().orders.captureOrder({ id: input.orderId, paypalRequestId: input.requestId, prefer: "return=representation" }));
  const o = r.data as { id?: string; status?: string; purchaseUnits?: { payments?: { captures?: { id?: string; status?: string; amount?: { value?: string; currencyCode?: string } }[] } }[] };
  const cap = o.purchaseUnits?.[0]?.payments?.captures?.[0];
  return {
    orderId: o.id!,
    status: o.status ?? "UNKNOWN",
    captureId: cap?.id ?? null,
    captureStatus: cap?.status ?? null,
    amount: { value: cap?.amount?.value ?? "", currency: cap?.amount?.currencyCode ?? "" },
    debugId: r.debugId,
  };
}

export async function searchTransactions(input: { days: number }) {
  const end = new Date();
  const start = new Date(end.getTime() - input.days * 86_400_000);
  const r = await sdkCall("Search transactions", () =>
    paypalSdk().transactions.searchTransactions({ startDate: start.toISOString(), endDate: end.toISOString(), fields: "transaction_info,payer_info", pageSize: 100 }),
  );
  const d = r.data as { transactionDetails?: { transactionInfo?: { transactionId?: string; transactionAmount?: { value?: string; currencyCode?: string }; transactionStatus?: string }; payerInfo?: { emailAddress?: string } }[]; totalItems?: number };
  const rows = (d.transactionDetails ?? []).map((t) => ({
    id: t.transactionInfo?.transactionId ?? null,
    amount: t.transactionInfo?.transactionAmount?.value ?? null,
    currency: t.transactionInfo?.transactionAmount?.currencyCode ?? null,
    status: t.transactionInfo?.transactionStatus ?? null,
    payerEmail: t.payerInfo?.emailAddress ?? null,
  }));
  return { count: d.totalItems ?? rows.length, rows, debugId: r.debugId };
}

// ── Payouts (REST) ───────────────────────────────────────────────────────────

export async function createPayout(input: { receiver: string; amount: Money; note: string; requestId: string }) {
  try {
    const r = await paypal().request<{ batch_header: { payout_batch_id: string; batch_status: string } }>({
      method: "POST",
      path: "/v1/payments/payouts",
      requestId: input.requestId,
      body: {
        // sender_batch_id is PayPal's own duplicate guard for payouts: same key, same batch.
        sender_batch_header: { sender_batch_id: input.requestId, email_subject: "Payment from PixelForge Studio", email_message: input.note.slice(0, 255) },
        items: [{ recipient_type: "EMAIL", receiver: input.receiver, amount: { value: input.amount.value, currency: input.amount.currency }, note: input.note.slice(0, 4000), sender_item_id: `${input.requestId}:1` }],
      },
    });
    return { payoutBatchId: r.data.batch_header.payout_batch_id, status: r.data.batch_header.batch_status, debugId: r.debugId, recovered: false };
  } catch (err) {
    const existing = existingBatchFor(err);
    if (!existing) throw err;
    // An earlier attempt created this batch and its reply was lost. Adopt it only if it is
    // provably ours and exactly what we asked for; otherwise surface PayPal's refusal.
    const batch = await getPayoutBatch(existing);
    const ours = batch.senderBatchId === input.requestId && batch.receiver?.toLowerCase() === input.receiver.toLowerCase() && batch.amount?.value === input.amount.value && batch.amount?.currency === input.amount.currency;
    if (!ours) throw err;
    return { payoutBatchId: existing, status: batch.status, debugId: batch.debugId, recovered: true };
  }
}

/** PayPal's "sender_batch_id already exists" refusal links the batch it already holds. */
export function existingBatchFor(err: unknown): string | null {
  if (!(err instanceof PayPalApiError) || err.status !== 400 || !Array.isArray(err.details)) return null;
  for (const d of err.details as { field?: string; link?: { href?: string }[] }[]) {
    if (d.field !== "SENDER_BATCH_ID") continue;
    const m = /\/v1\/payments\/payouts\/([A-Z0-9]{6,40})$/.exec(d.link?.[0]?.href ?? "");
    if (m) return m[1];
  }
  return null;
}

export async function getPayoutBatch(batchId: string) {
  const r = await paypal().request<{
    batch_header: { batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
    items?: { payout_item_id: string; transaction_status?: string; transaction_id?: string; payout_item?: { receiver?: string; amount?: { value?: string; currency?: string } } }[];
  }>({
    method: "GET",
    path: `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
  });
  const item = r.data.items?.[0];
  const amount = item?.payout_item?.amount;
  return {
    status: r.data.batch_header.batch_status,
    senderBatchId: r.data.batch_header.sender_batch_header?.sender_batch_id ?? null,
    itemCount: r.data.items?.length ?? 0,
    itemId: item?.payout_item_id ?? null,
    itemStatus: item?.transaction_status ?? null,
    transactionId: item?.transaction_id ?? null,
    receiver: item?.payout_item?.receiver ?? null,
    amount: amount?.value && amount.currency ? { value: amount.value, currency: amount.currency } : null,
    debugId: r.debugId,
  };
}

// ── Invoicing (REST) ─────────────────────────────────────────────────────────

type InvoiceRes = { id: string; status: string; detail?: { invoice_number?: string; metadata?: { recipient_view_url?: string } }; amount?: { value?: string; currency_code?: string } };

export async function createInvoiceDraft(input: { recipientEmail: string; amount: Money; description: string; dueDate?: string; note?: string; requestId: string }) {
  const r = await paypal().request<InvoiceRes>({
    method: "POST",
    path: "/v2/invoicing/invoices",
    requestId: input.requestId,
    preferRepresentation: true,
    body: {
      detail: {
        currency_code: input.amount.currency,
        note: input.note?.slice(0, 4000),
        payment_term: input.dueDate ? { term_type: "DUE_ON_DATE_SPECIFIED", due_date: input.dueDate } : { term_type: "DUE_ON_RECEIPT" },
      },
      invoicer: { business_name: "PixelForge Studio" },
      primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
      items: [{ name: input.description.slice(0, 200), quantity: "1", unit_amount: { currency_code: input.amount.currency, value: input.amount.value } }],
    },
  });
  return { invoiceId: r.data.id, status: r.data.status, debugId: r.debugId };
}

export async function sendInvoice(input: { invoiceId: string; requestId: string }) {
  const r = await paypal().request<{ href?: string }>({
    method: "POST",
    path: `/v2/invoicing/invoices/${encodeURIComponent(input.invoiceId)}/send`,
    requestId: input.requestId,
    body: { send_to_invoicer: false, send_to_recipient: true },
  });
  return { href: r.data?.href ?? null, debugId: r.debugId };
}

export async function getInvoice(invoiceId: string) {
  const r = await paypal().request<InvoiceRes & { payments?: { paid_amount?: { value?: string; currency_code?: string } } }>({
    method: "GET",
    path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
  });
  return {
    id: r.data.id,
    status: r.data.status,
    number: r.data.detail?.invoice_number ?? null,
    payerViewUrl: r.data.detail?.metadata?.recipient_view_url ?? null,
    amount: { value: r.data.amount?.value ?? "", currency: r.data.amount?.currency_code ?? "" },
    paid: { value: r.data.payments?.paid_amount?.value ?? "0", currency: r.data.payments?.paid_amount?.currency_code ?? r.data.amount?.currency_code ?? "" },
    debugId: r.debugId,
  };
}

export async function remindInvoice(input: { invoiceId: string; subject?: string; note?: string; requestId: string }) {
  const r = await paypal().request<unknown>({
    method: "POST",
    path: `/v2/invoicing/invoices/${encodeURIComponent(input.invoiceId)}/remind`,
    requestId: input.requestId,
    body: { subject: input.subject?.slice(0, 4000), note: input.note?.slice(0, 4000), send_to_invoicer: false, send_to_recipient: true },
  });
  return { debugId: r.debugId };
}

// ── Disputes / payout items (REST, read-only) ────────────────────────────────

export async function getDispute(disputeId: string) {
  const r = await paypal().request<{ dispute_id: string; status: string; reason?: string; dispute_amount?: { value?: string; currency_code?: string } }>({
    method: "GET",
    path: `/v1/customer/disputes/${encodeURIComponent(disputeId)}`,
  });
  return { id: r.data.dispute_id, status: r.data.status, reason: r.data.reason ?? null, amount: { value: r.data.dispute_amount?.value ?? "", currency: r.data.dispute_amount?.currency_code ?? "" }, debugId: r.debugId };
}

export async function getPayoutItem(itemId: string) {
  const r = await paypal().request<{ payout_item_id: string; transaction_status: string; payout_item?: { amount?: { value?: string; currency?: string }; receiver?: string } }>({
    method: "GET",
    path: `/v1/payments/payouts-item/${encodeURIComponent(itemId)}`,
  });
  return {
    id: r.data.payout_item_id,
    status: r.data.transaction_status,
    amount: { value: r.data.payout_item?.amount?.value ?? "", currency: r.data.payout_item?.amount?.currency ?? "" },
    receiver: r.data.payout_item?.receiver ?? null,
    debugId: r.debugId,
  };
}
