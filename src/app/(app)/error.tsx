"use client";

import Link from "next/link";
import { Button } from "@/components/ui";

/**
 * Shown when a page fails to render. It says what it can truthfully say — a
 * display failure does not move money or contact PayPal — and nothing more:
 * no stack trace, SQL or provider error reaches the screen (only a reference).
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="max-w-2xl py-10">
      <div className="pf-label">Something went wrong</div>
      <h1 className="mt-2 text-headline font-semibold tracking-[-0.02em]">This page couldn&rsquo;t be shown.</h1>
      <dl className="mt-6 grid grid-cols-[200px_minmax(0,1fr)] gap-x-6 gap-y-2 text-body">
        <dt className="text-muted">Did money move?</dt>
        <dd>Not because of this. Showing a page never sends anything to PayPal.</dd>
        <dt className="text-muted">What you can do</dt>
        <dd>Try again. If it keeps happening, the reference below helps find it in the server log.</dd>
      </dl>
      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className="text-body-sm text-muted hover:text-ink">
          Go home
        </Link>
      </div>
      {error.digest && <p className="mt-6 font-mono text-meta text-faint">reference {error.digest}</p>}
    </div>
  );
}
