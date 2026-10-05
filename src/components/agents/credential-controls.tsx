"use client";

import { Ban, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { revokeAgentAction, rotateAgentAction } from "@/app/(app)/agents/actions";
import { Button } from "@/components/ui";
import { OneTimeToken } from "./one-time-token";

/** Owner controls: rotate the credential (old one stops at once) or revoke the agent (immediately, for good). */
export function CredentialControls({ agentId, active }: { agentId: string; active: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!active) return null;
  if (token)
    return (
      <OneTimeToken
        token={token}
        onDone={() => {
          setToken(null);
          router.refresh();
        }}
      />
    );
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await rotateAgentAction(agentId);
              if (r.ok && r.token) setToken(r.token);
              else if (!r.ok) setError(r.error);
            })
          }
        >
          <RefreshCw size={14} aria-hidden /> Rotate credential
        </Button>
        {!confirm ? (
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
            <Ban size={14} aria-hidden /> Revoke agent
          </Button>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <input
              aria-label="Reason for revoking"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (recorded in the audit trail)"
              className="min-w-64 border-0 border-b border-field bg-transparent pb-1 text-body-sm outline-none"
            />
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await revokeAgentAction(agentId, reason);
                  if (r.ok) router.refresh();
                  else setError(r.error);
                })
              }
            >
              Revoke now
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </span>
        )}
      </div>
      <p className="mt-1.5 text-meta text-muted">Revoking takes effect on the agent&rsquo;s next call; requests waiting for review are withdrawn; nothing approved is sent afterwards.</p>
      {error && <p className="mt-1 text-body-sm text-danger">{error}</p>}
    </div>
  );
}
