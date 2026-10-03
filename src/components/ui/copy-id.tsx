"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A mono identifier (PayPal id, hash, debug id) with one-click copy. */
export function CopyId({ value, display, className = "" }: { value: string; display?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={`group inline-flex items-center gap-1 font-mono text-meta text-ink-2 ${className}`}>
      <span className="truncate" title={value}>
        {display ?? value}
      </span>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            /* clipboard unavailable: leave the value visible for manual copy */
          }
        }}
        className="rounded-sm p-0.5 text-faint opacity-60 transition-opacity duration-[var(--pf-dur-fast)] hover:text-ink group-hover:opacity-100"
        aria-label={copied ? "Copied" : `Copy ${value}`}
      >
        {copied ? <Check size={12} strokeWidth={2} className="text-ok" /> : <Copy size={12} strokeWidth={1.75} />}
      </button>
    </span>
  );
}
