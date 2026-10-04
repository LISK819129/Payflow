"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideApprovalAction } from "@/app/(app)/flows/actions";
import { Button } from "@/components/ui";

/**
 * Approve once / Reject. There is deliberately no "always allow": approving
 * covers this one request and never changes any authority.
 */
export function ApprovalDecision({ approvalId, amountLabel, canDecide, expired }: { approvalId: string; amountLabel: string | null; canDecide: boolean; expired: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!canDecide) return <p className="text-body-sm text-muted">Only owners and approvers can decide.</p>;
  if (expired) return <p className="text-body-sm text-danger">This request has expired; it will be closed as not approved.</p>;
  const decide = (d: "APPROVED" | "REJECTED") =>
    start(async () => {
      const r = await decideApprovalAction(approvalId, d, note || undefined);
      // Keep a refusal on screen (e.g. "Already approved" from another tab); refresh only on success.
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-56 flex-1">
          <span className="pf-label">Note (recorded in the audit trail)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink focus-visible:shadow-none" />
        </label>
        <Button variant="danger" onClick={() => decide("REJECTED")} disabled={pending}>
          Reject
        </Button>
        <Button variant="primary" onClick={() => decide("APPROVED")} disabled={pending}>
          Approve once{amountLabel ? ` · ${amountLabel}` : ""}
        </Button>
      </div>
      <p className="mt-2 text-meta text-muted">Approving covers this single request. It does not change the workflow&apos;s authority or allow similar requests later.</p>
      {error && <p className="mt-2 text-body-sm text-danger">{error}</p>}
    </div>
  );
}
