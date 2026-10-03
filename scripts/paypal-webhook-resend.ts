/**
 * Asks PayPal to redeliver a stored webhook event — a real duplicate delivery,
 * used to prove PayFlow processes each event exactly once.
 *
 *   pnpm paypal:webhook:resend WH-...
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { env } from "../src/server/config/env";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";

async function main() {
  const eventId = process.argv[2];
  const webhookId = env().PAYPAL_WEBHOOK_ID;
  if (!eventId || !webhookId) throw new Error("usage: pnpm paypal:webhook:resend <event-id> (PAYPAL_WEBHOOK_ID must be set)");
  const res = await paypal().request<{ id: string; event_type: string }>({
    method: "POST",
    path: `/v1/notifications/webhooks-events/${encodeURIComponent(eventId)}/resend`,
    requestId: `resend-${randomUUID()}`,
    body: { webhook_ids: [webhookId] },
  });
  console.log(`PayPal accepted redelivery of ${res.data.id} (${res.data.event_type})  debug_id=${res.debugId}`);
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
  else console.error(err);
  process.exit(1);
});
