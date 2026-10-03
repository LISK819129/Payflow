/**
 * Turns a verified PayPal event into the `trigger` object that workflow
 * expressions read. Field names are PayFlow's, stable across event types, so a
 * workflow says `trigger.amount` rather than knowing each resource's layout.
 * The full resource stays available under `trigger.resource`.
 */

export type Amount = { value: string; currency_code: string };

export type PayPalTrigger = {
  kind: "paypal_event";
  eventId: string;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  summary: string | null;
  amount: Amount | null;
  payer: { email: string | null; payerId: string | null; name: string | null };
  invoiceId: string | null;
  /** For captures: the order that produced it. */
  orderId: string | null;
  resource: Record<string, unknown>;
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

function amountOf(r: Record<string, unknown>): Amount | null {
  const pick = (a: unknown): Amount | null => {
    if (!a || typeof a !== "object") return null;
    const o = a as Record<string, unknown>;
    const value = str(o.value);
    const currency = str(o.currency_code) ?? str(o.currency);
    return value && currency ? { value, currency_code: currency } : null;
  };
  const invoice = r.invoice as Record<string, unknown> | undefined;
  const payoutItem = r.payout_item as Record<string, unknown> | undefined;
  return (
    pick(r.amount) ??
    pick((r.seller_receivable_breakdown as Record<string, unknown> | undefined)?.gross_amount) ??
    pick(invoice?.amount) ??
    pick(payoutItem?.amount) ??
    pick((r.dispute_amount as unknown) ?? null) ??
    null
  );
}

export function normalizePayPalEvent(raw: {
  id: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  resource?: Record<string, unknown>;
}): PayPalTrigger {
  const r = raw.resource ?? {};
  const payer = (r.payer ?? {}) as Record<string, unknown>;
  const payerName = (payer.name ?? {}) as Record<string, unknown>;
  const invoice = (r.invoice ?? {}) as Record<string, unknown>;
  const related = ((r.supplementary_data as Record<string, unknown> | undefined)?.related_ids ?? {}) as Record<string, unknown>;
  return {
    kind: "paypal_event",
    eventId: raw.id,
    eventType: raw.event_type,
    resourceType: raw.resource_type ?? null,
    resourceId: str(r.id),
    summary: raw.summary ?? null,
    amount: amountOf(r),
    payer: {
      email: str(payer.email_address),
      payerId: str(payer.payer_id),
      name: [str(payerName.given_name), str(payerName.surname)].filter(Boolean).join(" ") || null,
    },
    invoiceId: str(r.invoice_id) ?? str(invoice.id),
    orderId: str(related.order_id),
    resource: r,
  };
}
