/**
 * Points the PayFlow webhook on the Sandbox app at a public host (a tunnel in
 * development, the Render URL in production) with an explicit list of event
 * types — no wildcard. Reuses the existing webhook; never creates duplicates.
 * Prints the webhook id to put in PAYPAL_WEBHOOK_ID.
 *
 *   pnpm paypal:webhook:register https://<public-host>
 */
import "./load-env";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";
import { registerWebhook, WEBHOOK_EVENT_TYPES } from "../src/server/paypal/webhook-registration";

export { WEBHOOK_EVENT_TYPES };

async function main() {
  const host = process.argv[2];
  if (!host || !/^https:\/\//.test(host)) {
    console.error("Usage: pnpm paypal:webhook:register https://<public-host>");
    process.exit(2);
  }
  const r = await registerWebhook(paypal(), host);
  for (const id of r.removed) console.log(`Removed stale webhook ${id}`);
  console.log(`${r.action === "created" ? "Registered" : r.action === "unchanged" ? "Unchanged" : "Updated"} webhook ${r.id} → ${r.url} (${WEBHOOK_EVENT_TYPES.length} event types)`);
  console.log(`
PAYPAL_WEBHOOK_ID=${r.id}`);
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
  else console.error(err);
  process.exit(1);
});
