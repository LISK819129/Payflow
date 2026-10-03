import type { ReactNode } from "react";

/** Page title: modest size, the content does the talking. */
export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-10 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-headline font-semibold tracking-[-0.02em]">{title}</h1>
        {lead && <p className="mt-1.5 max-w-2xl text-lead text-muted">{lead}</p>}
      </div>
      {actions}
    </header>
  );
}

/** A section is a label and a hairline, not a card. */
export function Section({ label, aside, children, className = "" }: { label: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
        <h2 className="pf-label">{label}</h2>
        {aside && <div className="text-meta text-muted">{aside}</div>}
      </div>
      <div>{children}</div>
    </section>
  );
}

/** Row in a hairline list. */
export function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex items-center gap-4 border-b border-line py-3 last:border-b-0 ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-body text-faint">{children}</p>;
}
