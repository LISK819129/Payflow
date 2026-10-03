import { sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { z } from "zod";
import { appendAudit } from "../audit/audit";
import { env } from "../config/env";
import { db } from "../db/client";
import { paypalEvents } from "../db/schema";
import { QUEUES, boss } from "../jobs/boss";
import { paypal } from "../paypal/client";
import { readWebhookHeaders, verifyWebhook, type VerifyDeps } from "../paypal/webhook-verify";
import { merchantWorkspaceId } from "../workspace";

const eventShape = z.object({
  id: z.string().min(1).max(200),
  event_type: z.string().min(1).max(200),
  resource_type: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
  resource: z.record(z.string(), z.unknown()).optional(),
});

export type IngestResult =
  | { status: 200; outcome: "accepted" | "duplicate"; eventId: string }
  | { status: 400; outcome: "rejected"; reason: string };

export type IngestDeps = VerifyDeps & { enqueue?: boolean };

const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string> {
  const hit = certCache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`cert fetch HTTP ${res.status}`);
  const pem = await res.text();
  if (pem.length > 20_000 || !pem.includes("BEGIN CERTIFICATE")) throw new Error("cert response is not a PEM certificate");
  certCache.set(url, pem);
  return pem;
}

const postback: NonNullable<VerifyDeps["postback"]> = async ({ headers, webhookId, event }) => {
  const res = await paypal().request<{ verification_status?: string }>({
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    requestId: `verify-${headers.transmissionId}`,
    body: {
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return res.data.verification_status === "SUCCESS";
};

export const defaultIngestDeps: IngestDeps = { fetchCert, postback };

/**
 * Verify → persist once → enqueue. Returns quickly so PayPal gets its 2xx well
 * inside the 30 s window; all workflow processing happens in the worker.
 */
export async function ingestPayPalWebhook(
  rawBody: string,
  getHeader: (name: string) => string | null,
  deps: IngestDeps = defaultIngestDeps,
): Promise<IngestResult> {
  const headers = readWebhookHeaders(getHeader);
  const e = env();
  const verification = await verifyWebhook(
    { rawBody, headers, webhookId: e.PAYPAL_WEBHOOK_ID, allowSimulator: e.PAYPAL_ALLOW_SIMULATOR_EVENTS },
    deps,
  );
  if (!verification.ok) return { status: 400, outcome: "rejected", reason: verification.reason };

  let parsed: z.infer<typeof eventShape>;
  try {
    parsed = eventShape.parse(JSON.parse(rawBody));
  } catch {
    return { status: 400, outcome: "rejected", reason: "event body does not match the PayPal event shape" };
  }

  const workspaceId = await merchantWorkspaceId();
  const resourceId = typeof parsed.resource?.id === "string" ? parsed.resource.id : null;
  const provenance = verification.method === "SIMULATOR" ? "SIMULATED" : "REAL_PAYPAL_SANDBOX";

  return db().transaction(async (tx) => {
    // xmax = 0 only for a freshly inserted row: that's how a redelivery is told apart.
    const [row] = await tx
      .insert(paypalEvents)
      .values({
        workspaceId,
        eventId: parsed.id,
        eventType: parsed.event_type,
        resourceType: parsed.resource_type ?? null,
        resourceId,
        summary: parsed.summary ?? null,
        transmissionId: headers!.transmissionId,
        verification: verification.method,
        provenance,
        raw: JSON.parse(rawBody),
        rawBody,
        signature: headers,
      })
      .onConflictDoUpdate({
        target: paypalEvents.eventId,
        set: { deliveries: sql`${paypalEvents.deliveries} + 1`, lastDeliveryAt: sql`now()` },
      })
      .returning({ id: paypalEvents.id, deliveries: paypalEvents.deliveries, inserted: sql<boolean>`(xmax = 0)` });

    if (!row.inserted) {
      await appendAudit(tx, {
        workspaceId,
        actor: "paypal",
        kind: "paypal.webhook.duplicate",
        summary: `Duplicate delivery #${row.deliveries} of ${parsed.event_type} ignored`,
        payload: { eventId: parsed.id, transmissionId: headers!.transmissionId },
        paypalRef: resourceId,
      });
      return { status: 200 as const, outcome: "duplicate" as const, eventId: parsed.id };
    }

    await appendAudit(tx, {
      workspaceId,
      actor: "paypal",
      kind: "paypal.webhook.received",
      summary: `${parsed.event_type} received; signature verified (${verification.method.toLowerCase()})`,
      payload: { eventId: parsed.id, eventType: parsed.event_type, resourceId, verification: verification.method, provenance },
      paypalRef: resourceId,
    });

    if (deps.enqueue !== false) {
      // Same transaction as the insert: the event is never stored without its routing job, or vice versa.
      const b = await boss("web");
      await b.send(QUEUES.paypalEventRoute, { paypalEventId: row.id }, { db: fromDrizzle(tx, sql), singletonKey: parsed.id });
    }
    return { status: 200 as const, outcome: "accepted" as const, eventId: parsed.id };
  });
}
