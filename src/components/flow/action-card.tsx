import { CopyId, ProvenanceTag, Status, formatClock, formatMoney, type StatusTone } from "@/components/ui";
import type { actionExecutions } from "@/server/db/schema";

type Execution = typeof actionExecutions.$inferSelect;

const tone: Record<string, StatusTone> = { SUCCEEDED: "ok", FAILED: "danger", UNKNOWN: "warn", PREPARED: "neutral", SUBMITTING: "live" };
const label: Record<string, string> = { SUCCEEDED: "Succeeded at PayPal", FAILED: "Refused by PayPal", UNKNOWN: "Outcome unknown — review", PREPARED: "Prepared", SUBMITTING: "Sending to PayPal" };

const KIND: Record<string, string> = {
  "paypal.refund": "Refund",
  "paypal.payout": "Payout",
  "paypal.order_capture": "Order capture",
  "paypal.invoice_send": "Invoice",
  "paypal.invoice_remind": "Invoice reminder",
  "paypal.fetch": "PayPal lookup",
  "paypal.transaction_search": "Transaction search",
  "ledger.reconcile": "Reconciliation",
};

const short = (id: string) => (id.length > 30 ? `${id.slice(0, 28)}…` : id);

/**
 * Everything safe to know about one PayPal action: what was asked, what PayPal
 * returned, when, and under which authorization. Never shows credentials,
 * tokens or raw request headers.
 */
export function ActionCard({ ex, labels = {} }: { ex: Execution; labels?: Record<string, string> }) {
  const err = ex.error as { code?: string; message?: string; status?: number } | null;
  const gates = (ex.authorization as { gates?: { nodeId: string; port: string }[] } | null)?.gates ?? [];
  const intent = ex.intent as { movesMoney?: boolean; external?: boolean } | null;
  const gated = !!(intent?.movesMoney || intent?.external);
  const ms = ex.completedAt && ex.submittedAt ? ex.completedAt.getTime() - ex.submittedAt.getTime() : null;
  return (
    <div className="mt-2 rounded border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="pf-label text-ink">{KIND[ex.kind] ?? ex.kind}</span>
          <ProvenanceTag value={ex.provenance} />
        </div>
        <Status tone={tone[ex.status] ?? "neutral"}>{(ex.kind === "ledger.reconcile" && ex.status === "SUCCEEDED" ? "Verified with PayPal · recorded" : label[ex.status]) ?? ex.status}</Status>
      </div>
      <dl className="mt-3 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-sm">
        {ex.amountValue && (
          <>
            <dt className="text-muted">Amount</dt>
            <dd className="font-medium">
              {formatMoney(ex.amountValue, ex.currency ?? "USD")} <span className="font-mono text-meta text-muted">{ex.amountValue} {ex.currency}</span>
            </dd>
          </>
        )}
        {ex.counterparty && (
          <>
            <dt className="text-muted">Counterparty</dt>
            <dd className="font-mono text-meta">{ex.counterparty}</dd>
          </>
        )}
        {ex.targetRef && (
          <>
            <dt className="text-muted">Applies to</dt>
            <dd>
              <CopyId value={ex.targetRef} />
            </dd>
          </>
        )}
        {ex.paypalRefs.length > 0 && (
          <>
            <dt className="text-muted">PayPal ids</dt>
            <dd className="flex flex-wrap gap-x-3">
              {ex.paypalRefs.map((r) => (
                <CopyId key={r} value={r} />
              ))}
            </dd>
          </>
        )}
        {ex.paypalStatus && (
          <>
            <dt className="text-muted">PayPal status</dt>
            <dd className="font-mono text-meta">{ex.paypalStatus}</dd>
          </>
        )}
        <dt className="text-muted">Sent</dt>
        <dd className="font-mono text-meta">
          {ex.submittedAt ? formatClock(ex.submittedAt) : "—"}
          {ms !== null && ` · ${ms} ms`} · attempt {ex.attempts}
        </dd>
        {(ex.result as { recoveredAfterLostReply?: boolean } | null)?.recoveredAfterLostReply && (
          <>
            <dt className="text-muted">Recovery</dt>
            <dd className="text-body-sm">PayPal already held this from an earlier attempt whose reply was lost; verified as ours and adopted, not sent again.</dd>
          </>
        )}
        {ex.debugId && (
          <>
            <dt className="text-muted">debug_id</dt>
            <dd>
              <CopyId value={ex.debugId} />
            </dd>
          </>
        )}
        {err && (
          <>
            <dt className="text-muted">Failure</dt>
            <dd className="text-danger">
              {err.code}
              {err.status ? ` (HTTP ${err.status})` : ""}: {err.message}
            </dd>
          </>
        )}
        <dt className="text-muted">Authorised by</dt>
        <dd className="text-body-sm">{gates.map((g) => `${labels[g.nodeId] ?? g.nodeId} → ${g.port}`).join(" · ") || (gated ? "—" : "Not required: moves no money and contacts no one")}</dd>
        <dt className="text-muted">Idempotency key</dt>
        <dd>
          <CopyId value={ex.idempotencyKey} display={`${ex.idempotencyKey.slice(0, 22)}…`} />
        </dd>
        {ex.confirmedByEventId && (
          <>
            <dt className="text-muted">Confirmed by</dt>
            <dd>
              <CopyId value={ex.confirmedByEventId} display={short(ex.confirmedByEventId)} /> <span className="text-meta text-muted">PayPal webhook</span>
            </dd>
          </>
        )}
        {ex.lastEventType && (
          <>
            <dt className="text-muted">Latest event</dt>
            <dd className="font-mono text-meta">
              {ex.lastEventType}
              {ex.lastEventStatus && ` · ${ex.lastEventStatus}`}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
