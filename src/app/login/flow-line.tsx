/**
 * The PayFlow pipeline drawn as one marker line: what the product does,
 * not decoration. The line draws once on load (instant under reduced motion).
 */
const steps = [
  { k: "PayPal event", d: "Payment received · verified" },
  { k: "AI interprets", d: "Invoice match · behaviour" },
  { k: "Code enforces", d: "Limits · currency · counterparty" },
  { k: "Human authorizes", d: "Approval when required" },
  { k: "PayPal executes", d: "Sandbox action · audited" },
];

export function FlowLine() {
  const gap = 92;
  const top = 18;
  const height = top + gap * (steps.length - 1) + 24;
  const length = gap * (steps.length - 1);
  return (
    <figure className="relative" aria-label="How PayFlow moves money: PayPal event, AI interprets, code enforces, human authorizes, PayPal executes.">
      <svg width="28" height={height} className="absolute left-0 top-0" aria-hidden>
        <line x1="14" y1={top} x2="14" y2={top + length} stroke="var(--pf-line)" strokeWidth="2" />
        <line
          x1="14"
          y1={top}
          x2="14"
          y2={top + length}
          stroke="var(--pf-marker)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={length}
          style={{ ["--pf-line-length" as string]: length, animation: `pf-draw-line 1400ms var(--pf-ease) 250ms both` }}
        />
        {steps.map((_, i) => (
          <circle key={i} cx="14" cy={top + i * gap} r="5" fill="var(--pf-surface)" stroke="var(--pf-ink)" strokeWidth="1.5" />
        ))}
      </svg>
      <ol className="relative pl-12">
        {steps.map((s, i) => (
          <li key={s.k} style={{ height: gap, animationDelay: `${250 + i * 220}ms` }} className="animate-fade-up">
            <div className="pf-label text-ink">{s.k}</div>
            <div className="mt-1 text-body-sm text-muted">{s.d}</div>
          </li>
        ))}
      </ol>
    </figure>
  );
}
