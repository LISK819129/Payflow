import type { ReactNode } from "react";

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "sim" | "accent";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
  sim: "bg-sim-soft text-sim border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

export type Provenance = "REAL_PAYPAL_SANDBOX" | "SIMULATED" | "AI_GENERATED" | "USER_PROVIDED";

const provenanceLabel: Record<Provenance, [string, Tone]> = {
  REAL_PAYPAL_SANDBOX: ["Real PayPal Sandbox", "info"],
  SIMULATED: ["Simulated", "sim"],
  AI_GENERATED: ["AI-generated", "accent"],
  USER_PROVIDED: ["User-provided", "neutral"],
};

/** Every money-shaped record shows where it came from. */
export function ProvenanceBadge({ value }: { value: Provenance }) {
  const [label, tone] = provenanceLabel[value];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function formatTime(d: Date) {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
