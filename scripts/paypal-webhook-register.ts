/**
 * Registers (or updates) the PayFlow webhook on the sandbox app with an explicit
 * list of event types — no wildcard — and prints the webhook id to put in
 * PAYPAL_WEBHOOK_ID.
 *
 *   pnpm paypal:webhook:register https://<public-host>
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";

export const WEBHOOK_EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.REFUNDED",
  "INVOICING.INVOICE.UPDATED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
];

type Webhook = { id: string; url: string; event_types: { name: string }[] };

async function main() {
  const host = process.argv[2];
  if (!host || !/^https:\/\//.test(host)) {
    console.error("Usage: pnpm paypal:webhook:register https://<public-host>");
    process.exit(2);
  }
  const url = new URL("/api/webhooks/paypal", host).toString();
  const eventTypes = WEBHOOK_EVENT_TYPES.map((name) => ({ name }));

  const { data } = await paypal().request<{ webhooks: Webhook[] }>({ method: "GET", path: "/v1/notifications/webhooks" });
  const existing = data.webhooks.find((w) => w.url === url);

  if (existing) {
    await paypal().request({
      method: "PATCH",
      path: `/v1/notifications/webhooks/${existing.id}`,
      body: [{ op: "replace", path: "/event_types", value: eventTypes }],
    });
    console.log(`Updated existing webhook ${existing.id} → ${url}`);
    console.log(`\nPAYPAL_WEBHOOK_ID=${existing.id}`);
    return;
  }

  const created = await paypal().request<Webhook>({
    method: "POST",
    path: "/v1/notifications/webhooks",
    requestId: randomUUID(),
    body: { url, event_types: eventTypes },
  });
  console.log(`Registered webhook ${created.data.id} → ${url} (${eventTypes.length} event types)`);
  console.log(`\nPAYPAL_WEBHOOK_ID=${created.data.id}`);
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
  else console.error(err);
  process.exit(1);
});
