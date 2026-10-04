import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { CopyId, Empty, PageHeader, ProvenanceTag, Status, formatClock, formatDay, formatMoney, type StatusTone } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { listActions } from "@/server/workflow/queries";

const tone: Record<string, StatusTone> = { SUCCEEDED: "ok", FAILED: "danger", UNKNOWN: "warn", PREPARED: "neutral", SUBMITTING: "live" };
const KIND: Record<string, string> = {
  "paypal.refund": "Refund",
  "paypal.payout": "Payout",
  "paypal.order_capture": "Order capture",
  "paypal.invoice_send": "Invoice sent",
  "paypal.invoice_remind": "Invoice reminder",
  "paypal.fetch": "Lookup",
  "paypal.transaction_search": "Transaction search",
  "ledger.reconcile": "Reconciliation",
};

export default async function TransactionsPage() {
  const user = await requireUser();
  const rows = await listActions(user.workspaceId);
  return (
    <>
      <PageHeader
        title="Transactions"
        lead="Every PayPal action a workflow has taken. Each one ran only after its policy or approval gate, with an idempotency key so it can never run twice."
      />
      {rows.length === 0 ? (
        <Empty>No PayPal actions yet. They appear here when a workflow reaches a refund, payout, invoice or capture step.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left">
            <thead>
              <tr className="border-b border-line">
                {["When", "Action", "Amount", "Counterparty / target", "PayPal id", "Status", "Source", ""].map((h) => (
                  <th key={h} scope="col" className="pf-label py-2 pr-6 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ ex, workflowName }) => (
                <tr key={ex.id} className="border-b border-line align-top hover:bg-sunken/60">
                  <td className="whitespace-nowrap py-3 pr-6 font-mono text-meta text-muted">
                    {formatDay(ex.preparedAt)} {formatClock(ex.preparedAt)}
                  </td>
                  <td className="py-3 pr-6">
                    <div className="text-body font-medium">{KIND[ex.kind] ?? ex.kind}</div>
                    <div className="text-meta text-muted">{workflowName}</div>
                  </td>
                  <td className="py-3 pr-6 text-body font-medium">{ex.amountValue ? formatMoney(ex.amountValue, ex.currency ?? "USD") : "—"}</td>
                  <td className="max-w-56 py-3 pr-6 font-mono text-meta text-ink-2">
                    <div className="truncate">{ex.counterparty ?? ex.targetRef ?? "—"}</div>
                  </td>
                  <td className="py-3 pr-6">{ex.paypalRefs[0] ? <CopyId value={ex.paypalRefs[0]} /> : <span className="text-faint">—</span>}</td>
                  <td className="py-3 pr-6">
                    <Status tone={tone[ex.status] ?? "neutral"}>{ex.status.toLowerCase()}</Status>
                    {ex.confirmedByEventId && <div className="mt-0.5 text-meta text-muted">confirmed by webhook</div>}
                    {ex.status !== "SUCCEEDED" && ex.error != null && (
                      <div className="mt-0.5 max-w-48 break-words font-mono text-meta text-danger">{(ex.error as { code?: string }).code}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-3 pr-6">
                    <ProvenanceTag value={ex.provenance} />
                  </td>
                  <td className="py-3">
                    <Link href={`/executions/${ex.runId}`} className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
                      Run <ArrowRight size={13} aria-hidden />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
