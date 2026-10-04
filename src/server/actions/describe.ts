import type { actionExecutions } from "../db/schema";

type Row = typeof actionExecutions.$inferSelect;

const amt = (r: Row) => (r.amountValue ? `${r.amountValue} ${r.currency}` : "");

/** Plain-language account of a settled action, for the step explanation and audit. */
export function describeExecution(r: Row): string {
  const res = (r.result ?? {}) as Record<string, unknown>;
  const ref = r.paypalRefs[0] ?? "";
  switch (r.kind) {
    case "paypal.refund":
      return `Refunded ${amt(r)} on capture ${r.targetRef} · refund ${ref} ${r.paypalStatus}`;
    case "paypal.payout":
      return `Paid ${amt(r)} to ${r.counterparty} · payout batch ${ref} ${r.paypalStatus}`;
    case "paypal.order_capture":
      return `Captured ${amt(r)} for order ${r.targetRef} · capture ${String(res.captureId ?? "")} ${r.paypalStatus}`;
    case "paypal.invoice_send":
      return `Invoice ${String(res.number ?? ref)} for ${amt(r)} sent to ${r.counterparty} · ${r.paypalStatus}`;
    case "paypal.invoice_remind":
      return `Reminder sent for invoice ${r.targetRef}`;
    case "paypal.fetch":
      return `Fetched ${(r.intent as { target?: { type?: string } }).target?.type ?? "resource"} ${r.targetRef}: ${r.paypalStatus}`;
    case "paypal.transaction_search":
      return `Found ${String(res.count ?? 0)} PayPal transaction(s) in the last ${String(res.days ?? "?")} days`;
    case "ledger.reconcile":
      return `Invoice ${String(res.number ?? r.targetRef)} reconciled against ${amt(r)}`;
    default:
      return `${r.kind} ${r.paypalStatus ?? ""}`;
  }
}
