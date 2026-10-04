import { Check, CircleAlert, CircleX, Plus } from "lucide-react";
import Link from "next/link";
import { BudgetBar } from "@/components/authority/decision-trace";
import { buttonClass, Empty, formatClock, formatDay, PageHeader, Section } from "@/components/ui";
import { ACTION_LABEL, money } from "@/server/authority/evaluate";
import { listAuthorities, uncoveredActions, type AuthorityView } from "@/server/authority/queries";
import { requireUser } from "@/server/auth/current";
import { addDecimal } from "@/server/workflow/dsl/decimal";
import { StatusControl } from "./status-control";

export const dynamic = "force-dynamic";

const decisionIcon = {
  ALLOW: <Check size={14} strokeWidth={2.25} className="text-marker-ink" aria-label="allowed" />,
  REVIEW: <CircleAlert size={14} strokeWidth={1.75} className="text-warn" aria-label="sent to review" />,
  DENY: <CircleX size={14} strokeWidth={1.75} className="text-danger" aria-label="denied" />,
};

const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Clause({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="pf-label">{q}</dt>
      <dd className="mt-1.5 text-body text-ink">{children}</dd>
    </div>
  );
}

/** One authority, read as a sentence: who may do what, to whom, for how much, how often, until when. */
function Charter({ a, isOwner }: { a: AuthorityView; isOwner: boolean }) {
  const ccy = a.currencies[0];
  const active = a.status === "ACTIVE";
  const expired = !!a.expiresAt && a.expiresAt <= new Date();
  return (
    <article className={`border-t-2 ${active && !expired ? "border-ink" : "border-line-strong"} bg-surface px-6 py-6`} aria-label={`Authority ${a.name}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-title font-semibold">{a.name}</h2>
            <span className="font-mono text-meta text-muted">v{a.version}</span>
            {active && !expired ? (
              <span className="inline-flex items-center gap-1.5 text-body-sm font-medium text-ink">
                <span aria-hidden className="size-2 rounded-full bg-marker" /> Active
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 text-body-sm font-medium ${a.status === "REVOKED" ? "text-muted" : "text-warn"}`}>
                <CircleAlert size={14} aria-hidden />
                {expired && active ? "Expired" : a.status === "SUSPENDED" ? "Suspended" : "Revoked"}
                {a.statusReason && <span className="font-normal text-muted">— {a.statusReason}</span>}
              </span>
            )}
          </div>
          {a.description && <p className="mt-1 max-w-2xl text-body-sm text-muted">{a.description}</p>}
        </div>
        {isOwner && a.status !== "REVOKED" && (
          <div className="flex items-center gap-2">
            <Link href={`/authority/${a.id}/edit`} className={buttonClass("secondary", "sm")}>
              Edit
            </Link>
            <StatusControl id={a.id} status={a.status} />
          </div>
        )}
      </header>

      <dl className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-6">
        <Clause q="Who">
          {a.workflows.length ? (
            <ul>
              {a.workflows.map((w) => (
                <li key={w.id}>
                  <Link href={`/flows/${w.id}`} className="hover:underline">
                    {w.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            "—"
          )}
        </Clause>
        <Clause q="May do">{a.actions.map((k) => ACTION_LABEL[k] ?? k).join(", ")}</Clause>
        <Clause q="To whom">
          {a.counterpartyRule === "any" ? (
            "Anyone not denied"
          ) : (
            <ul>
              {a.counterparties.map((c) => (
                <li key={c.id} title={c.id}>
                  {c.name ?? c.id}
                </li>
              ))}
            </ul>
          )}
          {a.deniedCounterparties.length > 0 && <div className="mt-1 text-body-sm text-danger">Never: {a.deniedCounterparties.map((c) => c.name ?? c.id).join(", ")}</div>}
        </Clause>
        <Clause q="How much">
          <div>{a.perTransactionMax ? `≤ ${money(a.perTransactionMax, ccy)} each` : "No per-payment limit"}</div>
          <div className="text-body-sm text-muted">{a.currencies.join(", ")} only</div>
        </Clause>
        <Clause q="How often">
          <div>{a.budgetAmount ? `${money(a.budgetAmount, ccy)} a ${a.budgetPeriod}` : "No spending budget"}</div>
          {a.maxCount && (
            <div className="text-body-sm text-ink-2">
              {a.maxCount} action{a.maxCount === 1 ? "" : "s"} a {a.countPeriod}
            </div>
          )}
        </Clause>
        <Clause q="Until">
          <div>{a.expiresAt ? fmtDate(a.expiresAt) : "No expiry"}</div>
          {a.validFrom && <div className="text-body-sm text-muted">from {fmtDate(a.validFrom)}</div>}
        </Clause>
      </dl>

      {(a.budgetUsage || a.countUsage) && (
        <div className="mt-6 grid gap-8 border-t border-line pt-5 md:grid-cols-2">
          {a.budgetUsage && a.budgetAmount && (
            <div className="max-w-md">
              <div className="pf-label mb-2">Budget now</div>
              <BudgetBar
                now
                b={{
                  authorityId: a.id,
                  limit: a.budgetAmount,
                  currency: ccy,
                  period: a.budgetPeriod!,
                  periodKey: "",
                  periodLabel: a.budgetUsage.periodLabel,
                  committed: a.budgetUsage.committed,
                  reserved: a.budgetUsage.reserved,
                  request: "0",
                  after: addDecimal(a.budgetUsage.committed, a.budgetUsage.reserved),
                }}
              />
            </div>
          )}
          {a.countUsage && a.maxCount && (
            <div>
              <div className="pf-label mb-2">Frequency now</div>
              <div className="font-mono text-meta text-ink-2">
                {a.countUsage.periodLabel}: {a.countUsage.count} of {a.maxCount}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 border-t border-line pt-4">
        <div className="flex items-baseline justify-between">
          <div className="pf-label">Recent decisions</div>
          <div className="font-mono text-meta text-muted">
            {a.counts.allow} allowed · {a.counts.review} reviewed · {a.counts.deny} denied
          </div>
        </div>
        {a.recent.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted">No requests yet.</p>
        ) : (
          <ul className="mt-2">
            {a.recent.map((d) => {
              const r = d.request as { kind: string; amount: { value: string; currency: string } | null; counterparty: string | null };
              return (
                <li key={d.id} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-2 py-1 text-body-sm">
                  <span className="mt-[2px]">{decisionIcon[d.outcome === "ALLOW_AFTER_HUMAN_APPROVAL" ? "ALLOW" : d.decision]}</span>
                  <Link href={`/executions/${d.runId}`} className="truncate hover:underline">
                    <span className="font-medium text-ink">{d.outcome === "ALLOW_AFTER_HUMAN_APPROVAL" ? "Allowed after approval" : d.decision === "ALLOW" ? "Allowed" : d.decision === "REVIEW" ? "Sent to a person" : "Denied"}</span>
                    <span className="text-ink-2">
                      {" "}
                      · {ACTION_LABEL[r.kind] ?? r.kind} {r.amount ? money(r.amount.value, r.amount.currency) : ""} {r.counterparty ? `→ ${r.counterparty}` : ""}
                    </span>
                  </Link>
                  <span className="font-mono text-meta text-muted">
                    {formatDay(d.createdAt)} {formatClock(d.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}

export default async function AuthorityPage() {
  const user = await requireUser();
  const [list, gaps] = await Promise.all([listAuthorities(user.workspaceId), uncoveredActions(user.workspaceId)]);
  const isOwner = user.role === "OWNER";
  return (
    <>
      <PageHeader
        title="Authority"
        lead="What each workflow is allowed to do with money: who, what, to whom, how much, how often, until when. Anything outside it goes to a person, or is refused."
        actions={
          isOwner ? (
            <Link href="/authority/new" className={buttonClass("primary")}>
              <Plus size={15} aria-hidden /> New authority
            </Link>
          ) : null
        }
      />
      {gaps.length > 0 && (
        <Section label="Not covered by any authority" className="mb-10">
          <ul>
            {gaps.map((g) => (
              <li key={g.workflowId} className="flex items-start gap-2 border-b border-line py-2.5 text-body">
                <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                <span>
                  <Link href={`/flows/${g.workflowId}`} className="font-medium hover:underline">
                    {g.workflowName}
                  </Link>{" "}
                  <span className="text-ink-2">— {g.kinds.map((k) => ACTION_LABEL[k] ?? k).join(", ")} will always wait for a person.</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {list.length === 0 ? (
        <Empty>No delegated authority yet. Every PayPal action will wait for a person until one exists.</Empty>
      ) : (
        <div className="space-y-10">
          {list.map((a) => (
            <Charter key={a.id} a={a} isOwner={isOwner} />
          ))}
        </div>
      )}
    </>
  );
}
