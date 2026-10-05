const STATE_CLS: Record<string, string> = {
  COMPLETED: "border-marker-ink/60 text-marker-ink",
  REVIEW_REQUIRED: "border-warn/60 text-warn",
  APPROVED: "border-ink text-ink",
  ACCEPTED: "border-line-strong text-ink-2",
  PROCESSING: "border-line-strong text-ink-2",
  DENIED: "border-danger/60 text-danger",
  REJECTED: "border-danger/60 text-danger",
  FAILED: "border-danger/60 text-danger",
  UNKNOWN: "border-warn/60 text-warn",
  CANCELLED: "border-line-strong text-muted",
  ENDED: "border-line-strong text-muted",
  TEST_COMPLETE: "border-sim/60 bg-sim-wash text-sim",
};

/** The agent-facing state, as the agent sees it (REQUEST accepted ≠ payment completed). */
export function RequestState({ state }: { state: string }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-px font-mono text-[11px] font-semibold tracking-[0.02em] ${STATE_CLS[state] ?? "border-line text-muted"}`}>
      {state.replaceAll("_", " ")}
    </span>
  );
}

export function ago(d: Date | null, now = new Date()) {
  if (!d) return "never";
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}
