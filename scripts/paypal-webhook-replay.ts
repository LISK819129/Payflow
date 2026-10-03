/**
 * Replays a stored PayPal delivery — PayPal's exact signed bytes and original
 * transmission headers — at a PayFlow webhook URL. Models a duplicate delivery
 * or a captured-and-replayed request. Expected result: accepted as a duplicate,
 * deliveries + 1, no second routing job.
 *
 *   pnpm paypal:webhook:replay WH-... https://<public-host>
 */
import "./load-env";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { paypalEvents } from "../src/server/db/schema";
import type { WebhookHeaders } from "../src/server/paypal/webhook-verify";

async function main() {
  const [eventId, host] = process.argv.slice(2);
  if (!eventId || !host) throw new Error("usage: pnpm paypal:webhook:replay <event-id> <https-host>");
  const [ev] = await db().select().from(paypalEvents).where(eq(paypalEvents.eventId, eventId)).limit(1);
  if (!ev?.rawBody || !ev.signature) throw new Error(`${eventId} has no stored raw body/signature (received before they were kept)`);
  const h = ev.signature as WebhookHeaders;

  const res = await fetch(new URL("/api/webhooks/paypal", host), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-transmission-id": h.transmissionId,
      "paypal-transmission-time": h.transmissionTime,
      "paypal-transmission-sig": h.transmissionSig,
      "paypal-cert-url": h.certUrl,
      "paypal-auth-algo": h.authAlgo,
    },
    body: ev.rawBody,
  });
  console.log(`Replayed ${eventId} → HTTP ${res.status} ${await res.text()}`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
