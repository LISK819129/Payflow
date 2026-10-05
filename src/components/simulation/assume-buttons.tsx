"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { assumeAction } from "@/app/(app)/simulations/actions";
import { Button } from "@/components/ui";

/** Explore the rest of the path inside the test. Creates no approval; authorizes nothing. */
export function AssumeButtons({ simulationId, nodeId }: { simulationId: string; nodeId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (choice: "APPROVED" | "REJECTED") =>
    start(async () => {
      const r = await assumeAction(simulationId, nodeId, choice);
      if (r.ok) router.push(`/simulations/${r.id}`);
      else setError(r.error);
    });
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => go("APPROVED")} disabled={pending}>
          Assume approved
        </Button>
        <Button size="sm" variant="quiet" onClick={() => go("REJECTED")} disabled={pending}>
          Assume rejected
        </Button>
      </div>
      <p className="mt-1.5 text-meta text-muted">Only inside this test. No approval is created and nothing is authorized.</p>
      {error && <p className="mt-1 text-body-sm text-danger">{error}</p>}
    </div>
  );
}
