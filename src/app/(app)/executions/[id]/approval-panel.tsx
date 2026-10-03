"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideApprovalAction } from "@/app/(app)/flows/actions";
import { Button, formatMoney } from "@/components/ui";

type Props = {
  approval: { id: string; reason: string; summary: Record<string, unknown>; requestedAt: string };
  canDecide: boolean;
};

/**
 * The decision surface: the amount and its consequence dominate. The full
 * Approvals queue lands in Phase 6; this panel already decides real approvals.
 */
export function ApprovalPanel({ approval, canDecide }: Props) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const amount = approval.summary.amount as { value: string; currency: string } | null;
  const party = approval.summary.counterparty as string | null;

  const decide = (d: "APPROVED" | "REJECTED") =>
    start(async () => {
      const r = await decideApprovalAction(approval.id, d, note || undefined);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });

  return (
    <section className="border-y border-line bg-surface px-6 py-6" aria-labelledby="approval-h">
      <div id="approval-h" className="pf-label text-warn">
        Requires your approval
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-x-12 gap-y-4">
        <div>
          <div className="text-figure font-semibold tracking-[-0.02em]">{amount ? formatMoney(amount.value, amount.currency) : "—"}</div>
          {party && <div className="mt-1 text-lead text-ink-2">{party}</div>}
        </div>
        <dl className="max-w-md">
          <dt className="pf-label">Reason</dt>
          <dd className="mt-0.5 text-body text-ink">{approval.reason}</dd>
        </dl>
      </div>
      {canDecide ? (
        <div className="mt-6 flex flex-wrap items-end gap-3">
          <label className="block min-w-64 flex-1">
            <span className="pf-label">Note (optional, recorded in the audit trail)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink focus-visible:shadow-none" />
          </label>
          <Button variant="danger" onClick={() => decide("REJECTED")} disabled={pending}>
            Reject
          </Button>
          <Button variant="primary" onClick={() => decide("APPROVED")} disabled={pending}>
            Approve{amount ? ` ${formatMoney(amount.value, amount.currency)}` : ""}
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-body-sm text-muted">Only owners and approvers can decide.</p>
      )}
      {error && <p className="mt-3 text-body-sm text-danger">{error}</p>}
    </section>
  );
}
