import { ArrowUpRight, Clock } from "lucide-react";
import Link from "next/link";
import { CopyId, formatClock, formatDay, ProvenanceTag, type Provenance } from "@/components/ui";
import type { ApprovalView } from "@/server/approvals/queries";
import { ACTION_LABEL, money } from "@/server/authority/evaluate";
import { ApprovalDecision } from "./approval-decision";
import { DecisionTrace } from "./decision-trace";

function timeLeft(expiresAt: Date, now: Date) {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min left` : `${m} min left`;
}

/** One request for a person's decision: the money and its consequence lead, the evidence follows. */
export function ApprovalCard({ v, canDecide, now }: { v: ApprovalView; canDecide: boolean; now: Date }) {
  const amt = v.action?.amount;
  const what = v.action ? (ACTION_LABEL[v.action.kind] ?? v.action.label) : "Decision";
  const flagged = v.evaluations.filter((e) => e.result !== "pass");
  const expired = !!v.expiresAt && v.expiresAt <= now;
  const newerVersion = v.workflow.activeVersion !== null && v.workflow.activeVersion !== v.run.version;
  return (
    <article className="border-t-2 border-ink bg-surface px-6 py-6" aria-label={`Approval: ${what} ${amt ? money(amt.value, amt.currency) : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-3">
        <div>
          <div className="pf-label text-warn">{v.kind === "authority_review" ? "Outside delegated authority — needs you" : "Workflow asks for approval"}</div>
          <h2 className="mt-2 text-figure font-semibold tracking-[-0.02em]">
            {what} {amt ? money(amt.value, amt.currency) : ""}
          </h2>
          {v.action?.counterparty && <div className="mt-1 text-lead text-ink-2">to {v.action.counterparty}</div>}
          {v.action?.target && (
            <div className="mt-1 flex items-center gap-1 text-body-sm text-muted">
              on {v.action.target.type} <CopyId value={v.action.target.id} />
            </div>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
          <dt className="text-muted">Workflow</dt>
          <dd>
            <Link href={`/flows/${v.workflow.id}`} className="font-medium text-ink hover:underline">
              {v.workflow.name}
            </Link>{" "}
            <span className="text-muted">v{v.run.version}</span>
            {newerVersion && <span className="ml-1 text-warn">· v{v.workflow.activeVersion} is now active; this run stays on v{v.run.version}</span>}
            {v.workflow.state !== "ACTIVE" && <span className="ml-1 text-warn">· workflow {v.workflow.state.toLowerCase()}</span>}
          </dd>
          <dt className="text-muted">Run</dt>
          <dd className="flex items-center gap-2">
            <Link href={`/executions/${v.run.id}`} className="inline-flex items-center gap-0.5 text-ink hover:underline">
              Open run <ArrowUpRight size={13} aria-hidden />
            </Link>
            <ProvenanceTag value={v.run.provenance as Provenance} />
          </dd>
          <dt className="text-muted">PayPal context</dt>
          <dd className="font-mono text-meta text-ink-2">
            {v.paypalContext.eventType ? `${v.paypalContext.eventType} · ${v.paypalContext.resourceId ?? ""}` : `${v.run.triggerKind.replace("_", " ")} trigger`}
          </dd>
          <dt className="text-muted">Requested</dt>
          <dd className="font-mono text-meta">
            {formatDay(v.requestedAt)} {formatClock(v.requestedAt)}
          </dd>
          {v.expiresAt && (
            <>
              <dt className="text-muted">Expires</dt>
              <dd className={`inline-flex items-center gap-1 font-mono text-meta ${expired ? "text-danger" : "text-ink"}`}>
                <Clock size={12} aria-hidden /> {timeLeft(v.expiresAt, now)}
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="mt-6 grid gap-x-12 gap-y-6 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <h3 className="pf-label">Why you are asked</h3>
          <ul className="mt-2 space-y-1">
            {(flagged.length ? flagged.map((e) => e.detail) : [v.reason]).map((d, i) => (
              <li key={i} className="text-body text-ink">
                {d}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-body-sm font-medium text-ink">PayPal has not been contacted.</p>
        </div>
        <div>
          <h3 className="pf-label">What was checked</h3>
          <div className="mt-3">
            <DecisionTrace
              compact
              t={{
                request: { kind: v.action?.kind ?? "none", amount: amt ?? null, counterparty: v.action?.counterparty ?? null, target: v.action?.target ?? null },
                authorities: v.authorities,
                evaluations: v.evaluations,
                budget: v.budget,
                frequency: v.frequency,
                outcome: "REVIEW",
                human: { decision: "PENDING" },
                paypal: { contacted: false },
              }}
            />
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <ApprovalDecision approvalId={v.id} amountLabel={amt ? money(amt.value, amt.currency) : null} canDecide={canDecide} expired={expired} />
      </div>
    </article>
  );
}
