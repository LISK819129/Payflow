/**
 * How a PayPal webhook refers back to an action PayFlow took: the ids it names
 * and the status it reports. Shared by event routing (event arrives after the
 * action) and action completion (event arrived first).
 */

type Resource = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** Ids an event's resource names: refund/capture/order id, invoice id, payout batch id. */
export function eventRefs(resource: Resource): string[] {
  const invoice = resource.invoice as { id?: unknown } | undefined;
  const header = resource.batch_header as { payout_batch_id?: unknown } | undefined;
  return [str(resource.id), str(resource.invoice_id), str(invoice?.id), str(resource.payout_batch_id), str(header?.payout_batch_id)].filter((x): x is string => x !== null);
}

/** The status PayPal reports on the event's resource, whatever its shape. */
export function eventStatus(resource: Resource): string | null {
  return (
    str(resource.transaction_status) ??
    str((resource.batch_header as { batch_status?: unknown } | undefined)?.batch_status) ??
    str((resource.invoice as { status?: unknown } | undefined)?.status) ??
    str(resource.status)
  );
}
