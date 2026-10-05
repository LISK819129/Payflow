"use client";

import { RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";
import { restoreDemoAction } from "@/app/(app)/settings/demo-actions";
import { OneTimeToken } from "@/components/agents/one-time-token";
import { Button } from "@/components/ui";

export function RestoreDemo() {
  const [result, setResult] = useState<{ changes: string[]; token: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (result?.token) return <OneTimeToken token={result.token} onDone={() => setResult({ ...result, token: null })} />;
  return (
    <div>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await restoreDemoAction();
            if (r.ok) setResult({ changes: r.changes, token: r.token });
            else setError(r.error);
          })
        }
      >
        <RotateCcw size={14} aria-hidden /> {pending ? "Restoring…" : "Restore demo setup"}
      </Button>
      {result && <p className="mt-2 text-body-sm text-ink-2">{result.changes.length ? result.changes.join("; ") : "Already as configured — nothing changed."}</p>}
      {error && <p className="mt-2 text-body-sm text-danger">{error}</p>}
    </div>
  );
}
