import { CircleCheck, CircleDashed, CircleAlert, CircleX, FlaskConical, Hand, Radio, Sparkles, UserPen } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "danger" | "neutral" | "live" | "ai";

const toneStyle: Record<StatusTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-muted",
  live: "text-ink",
  ai: "text-marker-ink",
};

const toneIcon: Record<StatusTone, ReactNode> = {
  ok: <CircleCheck size={14} strokeWidth={1.75} aria-hidden />,
  warn: <CircleAlert size={14} strokeWidth={1.75} aria-hidden />,
  danger: <CircleX size={14} strokeWidth={1.75} aria-hidden />,
  neutral: <CircleDashed size={14} strokeWidth={1.75} aria-hidden />,
  live: <span aria-hidden className="animate-live-dot mx-[3px] inline-block size-2 rounded-full bg-marker" />,
  ai: <Sparkles size={14} strokeWidth={1.75} aria-hidden />,
};

/** State is never colour alone: icon + label + colour. */
export function Status({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-body-sm font-medium ${toneStyle[tone]}`}>
      {toneIcon[tone]}
      {children}
    </span>
  );
}

export type Provenance = "REAL_PAYPAL_SANDBOX" | "SIMULATED" | "AI_GENERATED" | "USER_PROVIDED";

const provenanceStyle: Record<Provenance, { label: string; cls: string; icon: ReactNode }> = {
  REAL_PAYPAL_SANDBOX: {
    label: "Real PayPal Sandbox",
    cls: "border-ink/80 text-ink",
    icon: <Radio size={12} strokeWidth={2} aria-hidden />,
  },
  SIMULATED: { label: "Simulated", cls: "border-sim/60 text-sim bg-sim-wash", icon: <FlaskConical size={12} strokeWidth={2} aria-hidden /> },
  AI_GENERATED: { label: "AI-generated", cls: "border-marker-ink/50 text-marker-ink", icon: <Sparkles size={12} strokeWidth={2} aria-hidden /> },
  USER_PROVIDED: { label: "User-provided", cls: "border-line-strong text-muted", icon: <UserPen size={12} strokeWidth={2} aria-hidden /> },
};

/** Where a money-shaped record came from. Shown next to every such record. */
export function ProvenanceTag({ value }: { value: Provenance }) {
  const p = provenanceStyle[value];
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-label font-semibold uppercase tracking-[0.06em] ${p.cls}`}>
      {p.icon}
      {p.label}
    </span>
  );
}

export function SetupRequired({ children = "Setup required" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-body-sm font-medium text-warn">
      <Hand size={14} strokeWidth={1.75} aria-hidden />
      {children}
    </span>
  );
}
