import { eq } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { db } from "../db/client";
import { paypalEvents } from "../db/schema";
import { PayPalApiError } from "../paypal/errors";
import type { PayPalHttp } from "../paypal/http";

/**
 * Worker step for a stored PayPal event. Real events are first confirmed
 * against PayPal's own event store, so the payload we act on is one PayPal
 * itself reports having sent. Workflow matching is added in Phase 3; until then
 * the event is recorded as routed with no matching workflows.
 */
export async function routePayPalEvent(paypalEventId: string, http: PayPalHttp) {
  const [event] = await db().select().from(paypalEvents).where(eq(paypalEvents.id, paypalEventId)).limit(1);
  if (!event) throw new Error(`paypal event ${paypalEventId} not found`);
  if (event.routedAt) return { skipped: "already routed" as const };

  let confirmation: Record<string, unknown> = { confirmed: false, reason: "simulator events are not stored by PayPal" };
  if (event.provenance === "REAL_PAYPAL_SANDBOX") {
    try {
      const res = await http.request<{ id: string; event_type: string }>({
        method: "GET",
        path: `/v1/notifications/webhooks-events/${encodeURIComponent(event.eventId)}`,
      });
      if (res.data.id !== event.eventId || res.data.event_type !== event.eventType) {
        throw new PayPalApiError(res.status, "EVENT_MISMATCH", "PayPal returned a different event for this id", res.debugId);
      }
      confirmation = { confirmed: true, debugId: res.debugId };
    } catch (err) {
      // Throwing lets pg-boss retry with backoff; after the retry limit the job fails visibly.
      await db().transaction((tx) =>
        appendAudit(tx, {
          workspaceId: event.workspaceId,
          actor: "system",
          kind: "paypal.event.confirm_failed",
          summary: `Could not confirm ${event.eventType} with PayPal: ${(err as Error).message}`,
          payload: { eventId: event.eventId, error: err instanceof PayPalApiError ? err.toJSON() : String(err) },
          paypalRef: event.resourceId,
        }),
      );
      throw err;
    }
  }

  await db().transaction(async (tx) => {
    await tx.update(paypalEvents).set({ routedAt: new Date() }).where(eq(paypalEvents.id, event.id));
    await appendAudit(tx, {
      workspaceId: event.workspaceId,
      actor: "system",
      kind: "paypal.event.routed",
      summary: confirmation.confirmed
        ? `${event.eventType} confirmed with PayPal API; no active workflows subscribed yet`
        : `${event.eventType} (simulated) routed; no active workflows subscribed yet`,
      payload: { eventId: event.eventId, ...confirmation, matchedWorkflows: [] },
      paypalRef: event.resourceId,
    });
  });
  return { routed: true as const, ...confirmation };
}
