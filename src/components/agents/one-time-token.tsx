"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui";

/** Shows a freshly issued credential once. PayFlow keeps only its hash; closing this loses it for good. */
export function OneTimeToken({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="border-t-2 border-marker bg-surface px-6 py-6" aria-label="New agent credential">
      <h2 className="inline-flex items-center gap-2 text-title font-semibold">
        <KeyRound size={18} aria-hidden /> Agent credential — shown once
      </h2>
      <p className="mt-1 max-w-2xl text-body-sm text-muted">
        Give this to the agent as a bearer token for PayFlow&rsquo;s MCP endpoint <span className="font-mono">/api/mcp</span>. PayFlow stores only a SHA-256 of it and cannot show it again. It grants no PayPal access and no
        approval rights.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <code className="break-all rounded-sm bg-sunken px-3 py-2 font-mono text-meta text-ink" data-testid="one-time-token">
          {token}
        </code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(token);
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="mt-6">
        <Button variant="primary" onClick={onDone}>
          I have stored it
        </Button>
      </div>
    </section>
  );
}
