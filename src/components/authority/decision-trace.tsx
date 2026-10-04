import { Check, CircleAlert, CircleX, Hand } from "lucide-react";
import type { ReactNode } from "react";
import { CopyId } from "@/components/ui";
import { ACTION_LABEL, money } from "@/server/authority/evaluate";
import { addDecimal } from "@/server/workflow/dsl/decimal";

const subDecimal = (a: string, b: string) => addDecimal(a, b.startsWith("-") ? b.slice(1) : `-${b}`);
import type { AuthorityOutcome, BudgetSnapshot, Evaluation, FrequencySnapshot } from "@/server/authority/types";

export type TraceData = {
  request: { kind: string; label?: string | null; amount: { value: string; currency: string } | null; counterparty: string | null; target?: { type: string; id: string } | null };
  authorities: { id: string; name: string; version: number | null }[];
  evaluations: Evaluation[];
  budget: BudgetSnapshot[];
  frequency: FrequencySnapshot[];
  outcome: AuthorityOutcome;
  human?: { decision: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"; by?: string | null; at?: Date | null; note?: string | null } | null;
  paypal?: { contacted: boolean; status?: string | null; refs?: string[]; failure?: string | null } | null;
};

const icon = {
  pass: <Check size={14} strokeWidth={2.25} className="text-marker-ink" aria-label="passed" />,
  review: <CircleAlert size={14} strokeWidth={1.75} className="text-warn" aria-label="needs review" />,
  deny: <CircleX size={14} strokeWidth={1.75} className="text-danger" aria-label="denied" />,
};

/** One stage of the flow: a label column, the connector, and the content. */
function Stage({ label, flowing, last, children }: { label: string; flowing: boolean; last?: boolean; children: ReactNode }) {
  return (
    <li className="relative grid grid-cols-[88px_18px_1fr] pb-4 last:pb-0">
      <span className="pf-label pt-0.5">{label}</span>
      <span aria-hidden className="relative flex justify-center">
        <span className={`relative z-10 mt-1.5 size-[9px] rounded-full border-[1.5px] ${flowing ? "border-marker bg-marker" : "border-line-strong bg-surface"}`} />
        {!last && <span className={`absolute bottom-[-6px] top-4 w-[2px] ${flowing ? "bg-marker" : "bg-line"}`} />}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function Checks({ items }: { items: Evaluation[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((e, i) => (
        <li key={i} className={`flex items-start gap-1.5 text-body-sm ${e.result === "pass" ? "text-ink-2" : e.result === "review" ? "text-warn" : "text-danger"}`}>
          <span className="mt-[3px] shrink-0">{icon[e.result]}</span>
          <span>
            {e.detail}
            {e.source === "ai" && <span className="ml-1.5 text-label font-semibold uppercase tracking-[0.06em] text-marker-ink">AI evidence</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Spent / reserved / this request against the limit. Never colour alone: every figure is written out. */
export function BudgetBar({ b, now = false }: { b: BudgetSnapshot; now?: boolean }) {
  const n = (v: string) => Number(v); // proportions for drawing only; all figures shown are exact strings
  const scale = Math.max(n(b.limit), n(b.after), 0.01);
  const pct = (v: string) => `${Math.min(100, (n(v) / scale) * 100)}%`;
  const over = n(b.after) > n(b.limit);
  return (
    <div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${money(b.committed, b.currency)} spent, ${money(b.reserved, b.currency)} reserved, ${money(b.request, b.currency)} requested, of ${money(b.limit, b.currency)}`}>
        <span className="absolute inset-y-0 left-0 bg-ink-2" style={{ width: pct(b.committed) }} />
        <span className="absolute inset-y-0 bg-ink-2/40" style={{ left: pct(b.committed), width: pct(b.reserved) }} />
        <span className={`absolute inset-y-0 ${over ? "bg-warn" : "bg-marker"}`} style={{ left: `calc(${pct(b.committed)} + ${pct(b.reserved)})`, width: pct(b.request) }} />
        {over && <span className="absolute inset-y-0 w-[2px] bg-ink" style={{ left: pct(b.limit) }} />}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-meta tabular-nums">
        <dt className="text-muted">{b.periodLabel}</dt>
        <dd className="text-ink">{money(b.limit, b.currency)}</dd>
        <dt className="text-muted">Spent</dt>
        <dd>{money(b.committed, b.currency)}</dd>
        <dt className="text-muted">Reserved</dt>
        <dd>{money(b.reserved, b.currency)}</dd>
        {now ? (
          <>
            <dt className="text-muted">Left</dt>
            <dd className={over ? "font-semibold text-warn" : "font-semibold text-ink"}>{over ? `over by ${money(subDecimal(b.after, b.limit), b.currency)}` : money(subDecimal(b.limit, b.after), b.currency)}</dd>
          </>
        ) : (
          <>
            <dt className="text-muted">Request</dt>
            <dd>{money(b.request, b.currency)}</dd>
            <dt className="text-muted">After</dt>
            <dd className={over ? "font-semibold text-warn" : "font-semibold text-ink"}>
              {money(b.after, b.currency)}
              {over && " — over budget"}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

const outcomeView: Record<AuthorityOutcome, { label: string; cls: string; icon: ReactNode }> = {
  ALLOW: { label: "Allow", cls: "bg-marker text-on-marker", icon: <Check size={13} strokeWidth={2.5} aria-hidden /> },
  ALLOW_AFTER_HUMAN_APPROVAL: { label: "Allow — approved once by a person", cls: "bg-marker text-on-marker", icon: <Hand size={13} strokeWidth={2} aria-hidden /> },
  REVIEW: { label: "Human review", cls: "border border-warn text-warn", icon: <CircleAlert size={13} strokeWidth={2} aria-hidden /> },
  DENY: { label: "Deny", cls: "border border-danger text-danger", icon: <CircleX size={13} strokeWidth={2} aria-hidden /> },
};

/**
 * REQUEST → AUTHORITY → BUDGET → DECISION → (HUMAN) → PAYPAL. The connector is
 * marker-cyan only where money was actually permitted to flow.
 */
export function DecisionTrace({ t, compact = false }: { t: TraceData; compact?: boolean }) {
  const permitted = t.outcome === "ALLOW" || t.outcome === "ALLOW_AFTER_HUMAN_APPROVAL";
  const standing = t.evaluations.filter((e) => e.check !== "budget" && e.check !== "frequency");
  const limits = t.evaluations.filter((e) => e.check === "budget" || e.check === "frequency");
  const what = ACTION_LABEL[t.request.kind] ?? t.request.kind;
  const o = outcomeView[t.outcome];
  const human = t.human;
  return (
    <ol className="relative">
      <Stage label="Request" flowing>
        <div className="text-body font-medium text-ink">
          {what}
          {t.request.amount && ` ${money(t.request.amount.value, t.request.amount.currency)}`}
          {t.request.counterparty && <span className="font-normal text-ink-2"> → {t.request.counterparty}</span>}
        </div>
        {t.request.target && (
          <div className="mt-0.5 flex items-center gap-1 text-meta text-muted">
            {t.request.target.type} <CopyId value={t.request.target.id} />
          </div>
        )}
      </Stage>
      <Stage label="Authority" flowing={!standing.some((e) => e.result === "deny")}>
        <div className="mb-1 text-body-sm text-muted">
          {t.authorities.length ? t.authorities.map((a) => `${a.name}${a.version ? ` v${a.version}` : ""}`).join(" + ") : "No delegated authority"}
        </div>
        <Checks items={compact ? standing.filter((e) => e.result !== "pass" || e.check !== "status") : standing} />
      </Stage>
      {(t.budget.length > 0 || limits.length > 0) && (
        <Stage label="Budget" flowing={!limits.some((e) => e.result !== "pass")}>
          {t.budget.map((b) => (
            <div key={b.authorityId} className="mb-2 max-w-sm">
              <BudgetBar b={b} />
            </div>
          ))}
          {t.frequency.map((f) => (
            <div key={f.authorityId} className="mb-1 font-mono text-meta text-ink-2">
              {f.periodLabel}: {f.used} used · this would be {f.after} of {f.max}
            </div>
          ))}
          {limits.length > 0 && t.budget.length === 0 && t.frequency.length === 0 && <Checks items={limits} />}
        </Stage>
      )}
      <Stage label="Decision" flowing={permitted}>
        <span className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-semibold uppercase tracking-[0.06em] ${o.cls}`}>
          {o.icon}
          {o.label}
        </span>
      </Stage>
      {human && (
        <Stage label="Person" flowing={human.decision === "APPROVED"}>
          <div className={`text-body-sm ${human.decision === "APPROVED" ? "text-ink" : human.decision === "PENDING" ? "text-warn" : "text-danger"}`}>
            {human.decision === "PENDING" ? "Waiting for a decision" : human.decision === "APPROVED" ? "Approved once" : human.decision === "EXPIRED" ? "Expired without a decision" : "Rejected"}
            {human.by && ` by ${human.by}`}
            {human.at && <span className="font-mono text-meta text-muted"> · {human.at.toISOString().slice(0, 16).replace("T", " ")} UTC</span>}
          </div>
          {human.note && <div className="text-meta text-muted">“{human.note}”</div>}
        </Stage>
      )}
      <Stage label="PayPal" flowing={!!t.paypal?.contacted} last>
        {t.paypal?.contacted ? (
          <div className="text-body-sm text-ink">
            {t.paypal.failure ? <span className="text-danger">Refused: {t.paypal.failure}</span> : <>Sent · {t.paypal.status ?? "pending"}</>}
            {t.paypal.refs && t.paypal.refs.length > 0 && (
              <span className="ml-2 inline-flex gap-2">
                {t.paypal.refs.slice(0, 2).map((r) => (
                  <CopyId key={r} value={r} />
                ))}
              </span>
            )}
          </div>
        ) : (
          <div className="text-body-sm font-medium text-ink">PayPal has not been contacted.</div>
        )}
      </Stage>
    </ol>
  );
}
