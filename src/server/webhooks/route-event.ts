import { and, eq, inArray } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { db } from "../db/client";
import { paypalEvents, workflowVersions, workflows } from "../db/schema";
import { PayPalApiError } from "../paypal/errors";
import type { PayPalHttp } from "../paypal/http";
import { evaluate, ExpressionError, type Expr } from "../workflow/dsl/expression";
import type { WorkflowGraph } from "../workflow/dsl/nodes";
import { startRun } from "../workflow/runtime/engine";
import { normalizePayPalEvent } from "../workflow/runtime/trigger";
import type { RuntimeDeps } from "../workflow/runtime/types";

/**
 * Worker step for a stored PayPal event:
 *  1. real events are confirmed against PayPal's own event store, so the payload
 *     we act on is one PayPal itself reports having sent;
 *  2. the event is normalised into a trigger and matched to every ACTIVE
 *     workflow whose PayPal-event trigger lists its type (and whose optional
 *     filter passes); one run is started per workflow, idempotently.
 * Paused or frozen workflows that would have matched are recorded, not run.
 */
export async function routePayPalEvent(paypalEventId: string, http: PayPalHttp, deps: RuntimeDeps) {
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

  const trigger = normalizePayPalEvent(event.raw as Parameters<typeof normalizePayPalEvent>[0]);

  // Candidate workflows: anything in the workspace with an active version listening to this event type.
  const candidates = await db()
    .select({ wf: workflows, graph: workflowVersions.graph })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.activeVersionId))
    .where(and(eq(workflows.workspaceId, event.workspaceId), inArray(workflows.state, ["ACTIVE", "PAUSED", "FROZEN"])));

  const matched: { workflowId: string; runId?: string; skipped?: string }[] = [];
  for (const { wf, graph } of candidates) {
    const t = (graph as WorkflowGraph).nodes.find((n) => n.type === "trigger.paypal_event");
    if (!t || !(t.config.eventTypes as string[]).includes(event.eventType)) continue;
    if (t.config.filter) {
      try {
        if (!evaluate(t.config.filter as Expr, { trigger })) continue;
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        matched.push({ workflowId: wf.id, skipped: `filter could not be evaluated: ${e.message}` });
        continue;
      }
    }
    const r = await startRun(
      {
        workflowId: wf.id,
        triggerKind: "paypal_event",
        triggerRef: event.eventId,
        triggerPayload: trigger as unknown as Record<string, unknown>,
        provenance: event.provenance === "SIMULATED" ? "SIMULATED" : "REAL_PAYPAL_SANDBOX",
      },
      deps,
    );
    matched.push("runId" in r ? { workflowId: wf.id, runId: r.runId } : { workflowId: wf.id, skipped: r.skipped });
  }

  const started = matched.filter((m) => m.runId).length;
  const held = matched.filter((m) => m.skipped);
  await db().transaction(async (tx) => {
    await tx.update(paypalEvents).set({ routedAt: new Date() }).where(eq(paypalEvents.id, event.id));
    await appendAudit(tx, {
      workspaceId: event.workspaceId,
      actor: "system",
      kind: "paypal.event.routed",
      summary:
        (confirmation.confirmed ? `${event.eventType} confirmed with PayPal API; ` : `${event.eventType} (simulated); `) +
        (started === 0 && held.length === 0
          ? "no active workflows subscribed"
          : `started ${started} run(s)${held.length ? `, ${held.length} workflow(s) held (${held.map((h) => h.skipped).join("; ")})` : ""}`),
      payload: { eventId: event.eventId, ...confirmation, matched },
      paypalRef: event.resourceId,
    });
  });
  return { routed: true as const, ...confirmation, matched };
}
