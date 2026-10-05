import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../db/client";
import { actionExecutions, paypalEvents } from "../db/schema";

/**
 * What PayPal has actually done with an action PayFlow sent — kept separate
 * from "PayFlow sent it". PayPal accepting a payout batch is not the recipient
 * receiving money.
 *
 * PayPal semantics used (Payouts v1, Payments v2, Invoicing v2):
 * - Payout batch: PENDING / PROCESSING while PayPal works; SUCCESS means the
 *   batch was processed — not that each recipient was paid.
 * - Payout item (the recipient): SUCCESS = funds credited to the recipient;
 *   UNCLAIMED = recipient has no PayPal account yet, funds held and returned
 *   after 30 days unless claimed; PENDING / ONHOLD = still processing;
 *   FAILED / DENIED / BLOCKED / CANCELED = not paid; RETURNED / REFUNDED /
 *   REVERSED = paid then given back.
 * - Refund: COMPLETED settled; PENDING processing; CANCELLED / FAILED not done.
 * - Capture: COMPLETED settled; PENDING processing; DECLINED / FAILED not done.
 * - Invoices, reminders, look-ups, reconciliation move no money: done when PayPal accepted them.
 */
export type SettlementStage = "NOT_SENT" | "SUBMITTED" | "PROCESSING" | "SETTLED" | "AWAITING_RECIPIENT" | "FAILED" | "RETURNED" | "UNKNOWN" | "DONE";

export type Settlement = {
  stage: SettlementStage;
  /** PayPal's own status word that decided the stage. */
  paypalStatus: string | null;
  /** Where that status came from. */
  source: "paypal_response" | "paypal_webhook" | "payflow";
  /** True only when PayPal has confirmed the money reached (or definitively did not reach) its destination. */
  final: boolean;
  label: string;
  explanation: string;
};

export const STAGE_LABEL: Record<SettlementStage, string> = {
  NOT_SENT: "Not sent to PayPal",
  SUBMITTED: "Submitted to PayPal",
  PROCESSING: "PayPal processing",
  SETTLED: "Settled",
  AWAITING_RECIPIENT: "Awaiting recipient",
  FAILED: "Failed at PayPal",
  RETURNED: "Returned",
  UNKNOWN: "Outcome unknown",
  DONE: "Done at PayPal",
};

type Ex = Pick<typeof actionExecutions.$inferSelect, "kind" | "status" | "attempts" | "paypalStatus" | "paypalRefs" | "error" | "confirmedByEventId">;
/** PayPal events about this action's resources, oldest first: { eventType, status }. */
export type ResourceEvent = { eventType: string; status: string | null };

const ITEM: Record<string, SettlementStage> = {
  SUCCESS: "SETTLED",
  SUCCEEDED: "SETTLED",
  UNCLAIMED: "AWAITING_RECIPIENT",
  PENDING: "PROCESSING",
  ONHOLD: "PROCESSING",
  FAILED: "FAILED",
  DENIED: "FAILED",
  BLOCKED: "FAILED",
  CANCELED: "FAILED",
  CANCELLED: "FAILED",
  RETURNED: "RETURNED",
  REFUNDED: "RETURNED",
  REVERSED: "RETURNED",
};

const make = (stage: SettlementStage, paypalStatus: string | null, source: Settlement["source"], explanation: string): Settlement => ({
  stage,
  paypalStatus,
  source,
  final: ["SETTLED", "FAILED", "RETURNED", "DONE", "NOT_SENT"].includes(stage),
  label: STAGE_LABEL[stage],
  explanation,
});

export function settlementOf(ex: Ex, events: ResourceEvent[] = []): Settlement {
  if (ex.status === "PREPARED" || ex.status === "SUBMITTING") {
    return ex.attempts > 0 ? make("SUBMITTED", null, "payflow", "Being sent to PayPal") : make("NOT_SENT", null, "payflow", "Prepared; not yet sent to PayPal");
  }
  if (ex.status === "UNKNOWN") return make("UNKNOWN", null, "payflow", "PayPal gave no definitive answer; held for a person to reconcile");
  if (ex.status === "FAILED") {
    return ex.attempts === 0
      ? make("NOT_SENT", null, "payflow", (ex.error as { message?: string } | null)?.message ?? "Stopped before PayPal was contacted")
      : make("FAILED", null, "paypal_response", (ex.error as { message?: string } | null)?.message ?? "PayPal refused the action");
  }
  // SUCCEEDED: PayPal accepted the request. What happened to the money?
  const s = (ex.paypalStatus ?? "").toUpperCase() || null;
  switch (ex.kind) {
    case "paypal.payout": {
      const item = [...events].reverse().find((e) => e.eventType.startsWith("PAYMENT.PAYOUTS-ITEM.") && e.status);
      if (item) {
        const st = item.status!.toUpperCase();
        const stage = ITEM[st] ?? "PROCESSING";
        const why: Record<SettlementStage, string> = {
          SETTLED: "PayPal reports the recipient was paid",
          AWAITING_RECIPIENT: "PayPal sent it, but the recipient has no PayPal account yet; PayPal holds the funds and returns them after 30 days unless claimed",
          PROCESSING: "PayPal is still processing this payment to the recipient",
          FAILED: "PayPal reports the payment to the recipient failed",
          RETURNED: "PayPal reports the payment was returned",
        } as Record<SettlementStage, string>;
        return make(stage, st, "paypal_webhook", why[stage] ?? `PayPal item status ${st}`);
      }
      const fromEvent = [...events].reverse().find((e) => e.eventType.startsWith("PAYMENT.PAYOUTSBATCH.") && e.status)?.status?.toUpperCase();
      const batch = fromEvent ?? s;
      const source = fromEvent ? "paypal_webhook" : "paypal_response";
      if (batch === "DENIED" || batch === "CANCELED") return make("FAILED", batch, source, "PayPal denied the payout batch");
      if (batch === "SUCCESS") return make("PROCESSING", batch, source, "PayPal processed the batch; the recipient's status has not been reported yet");
      return make("SUBMITTED", batch, "paypal_response", "PayPal accepted the payout and is processing it");
    }
    case "paypal.refund":
    case "paypal.order_capture": {
      const st = s ?? "";
      if (st === "COMPLETED") return make("SETTLED", st, ex.confirmedByEventId ? "paypal_webhook" : "paypal_response", ex.kind === "paypal.refund" ? "PayPal completed the refund" : "PayPal completed the capture");
      if (["FAILED", "DECLINED", "CANCELLED", "CANCELED"].includes(st)) return make("FAILED", st, "paypal_response", `PayPal reports ${st.toLowerCase()}`);
      return make("PROCESSING", st || null, "paypal_response", "PayPal accepted it and is still processing");
    }
    default:
      return make("DONE", s, "paypal_response", "PayPal accepted the action; no money moves with it");
  }
}

/** PayPal events that mention any of the given resource ids (payout batch id, refund id, …), oldest first. */
export async function eventsFor(handle: DbOrTx, workspaceId: string, refs: string[]): Promise<ResourceEvent[]> {
  if (!refs.length) return [];
  const list = sql.join(refs.map((r) => sql`${r}`), sql`, `);
  const rows = await handle
    .select({ eventType: paypalEvents.eventType, raw: paypalEvents.raw })
    .from(paypalEvents)
    .where(
      and(
        eq(paypalEvents.workspaceId, workspaceId),
        eq(paypalEvents.provenance, "REAL_PAYPAL_SANDBOX"),
        sql`(${paypalEvents.raw}->'resource'->>'payout_batch_id' in (${list}) or ${paypalEvents.raw}->'resource'->'batch_header'->>'payout_batch_id' in (${list}) or ${paypalEvents.raw}->'resource'->>'id' in (${list}))`,
      ),
    )
    .orderBy(asc(paypalEvents.receivedAt));
  return rows.map((r) => {
    const res = ((r.raw as { resource?: Record<string, unknown> }).resource ?? {}) as Record<string, unknown>;
    const status = (res.transaction_status as string | undefined) ?? ((res.batch_header as { batch_status?: string } | undefined)?.batch_status) ?? (res.status as string | undefined) ?? null;
    return { eventType: r.eventType, status };
  });
}

/** Settlement for several executions at once (one events query). */
export async function settlementsFor(workspaceId: string, exs: (Ex & { id: string })[]): Promise<Map<string, Settlement>> {
  const refs = [...new Set(exs.flatMap((e) => e.paypalRefs))];
  const evs = refs.length
    ? await db()
        .select({ eventType: paypalEvents.eventType, raw: paypalEvents.raw })
        .from(paypalEvents)
        .where(and(eq(paypalEvents.workspaceId, workspaceId), eq(paypalEvents.provenance, "REAL_PAYPAL_SANDBOX"), inArray(paypalEvents.eventType, PAYPAL_RESOURCE_EVENTS)))
        .orderBy(asc(paypalEvents.receivedAt))
    : [];
  const out = new Map<string, Settlement>();
  for (const ex of exs) {
    const mine = evs
      .map((r) => {
        const res = ((r.raw as { resource?: Record<string, unknown> }).resource ?? {}) as Record<string, unknown>;
        const ids = [res.payout_batch_id, (res.batch_header as { payout_batch_id?: string } | undefined)?.payout_batch_id, res.id].filter(Boolean) as string[];
        if (!ids.some((i) => ex.paypalRefs.includes(i))) return null;
        return { eventType: r.eventType, status: (res.transaction_status as string | undefined) ?? (res.batch_header as { batch_status?: string } | undefined)?.batch_status ?? (res.status as string | undefined) ?? null };
      })
      .filter((x): x is ResourceEvent => !!x);
    out.set(ex.id, settlementOf(ex, mine));
  }
  return out;
}

const PAYPAL_RESOURCE_EVENTS = [
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
];
