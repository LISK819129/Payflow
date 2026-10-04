/**
 * Development tool: records an external payment (e.g. a bank transfer) against
 * a PayPal Sandbox invoice, the way the merchant would in PayPal. PayPal then
 * marks it paid and sends a genuine INVOICING.INVOICE.PAID webhook. Sandbox only.
 *
 *   pnpm paypal:sandbox:invoice-paid INV2-XXXX-XXXX-XXXX-XXXX [amount]
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";
import { getInvoice } from "../src/server/paypal/operations";

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId || !/^INV2-[A-Z0-9-]+$/.test(invoiceId)) throw new Error("usage: invoice-paid <INV2-…> [amount]");
  const inv = await getInvoice(invoiceId);
  const amount = process.argv[3] ?? inv.amount.value;
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("amount must look like 1200.00");
  console.log(`Invoice ${inv.id} (${inv.number}) is ${inv.status}, ${inv.amount.value} ${inv.amount.currency}`);

  const r = await paypal().request<{ payment_id: string }>({
    method: "POST",
    path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`,
    requestId: `invoice-paid-${randomUUID()}`,
    body: {
      method: "BANK_TRANSFER",
      payment_date: new Date().toISOString().slice(0, 10),
      amount: { currency_code: inv.amount.currency, value: amount },
      note: "Client paid by bank transfer (recorded by the merchant)",
    },
  });
  const after = await getInvoice(invoiceId);
  console.log(`Recorded payment ${r.data.payment_id} of ${amount} ${inv.amount.currency} → invoice ${after.status}  (debug_id ${r.debugId})`);
}

main().catch((e) => {
  console.error(e instanceof PayPalApiError ? e.toJSON() : e);
  process.exit(1);
});
