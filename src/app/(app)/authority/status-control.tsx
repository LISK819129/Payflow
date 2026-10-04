"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { setAuthorityStatusAction } from "./actions";

/** Suspend asks for a reason; resuming is one click. Both are audited as authority changes. */
export function StatusControl({ id, status }: { id: string; status: "ACTIVE" | "SUSPENDED" | "REVOKED" }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (to: "ACTIVE" | "SUSPENDED") =>
    start(async () => {
      const r = await setAuthorityStatusAction(id, to, reason || undefined);
      if (!r.ok) setError(r.error);
      else {
        setAsking(false);
        router.refresh();
      }
    });
  if (status === "SUSPENDED") {
    return (
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run("ACTIVE")}>
        Resume
      </Button>
    );
  }
  if (!asking) {
    return (
      <Button size="sm" variant="danger" onClick={() => setAsking(true)}>
        Suspend
      </Button>
    );
  }
  return (
    <div className="flex items-end gap-2">
      <label className="block">
        <span className="pf-label">Reason</span>
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-56 border-0 border-b border-field bg-transparent pb-1 text-body outline-none focus:border-ink" />
      </label>
      <Button size="sm" variant="danger" disabled={pending || reason.trim().length < 3} onClick={() => run("SUSPENDED")}>
        Suspend now
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setAsking(false)}>
        Cancel
      </Button>
      {error && <span className="text-body-sm text-danger">{error}</span>}
    </div>
  );
}
