import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { CopyId, Empty, PageHeader, Status, buttonClass, formatClock } from "@/components/ui";
import { verifyChain } from "@/server/audit/audit";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { auditRecords } from "@/server/db/schema";

/** Plain-language heading for each record kind; the raw kind stays in the details. */
function headingFor(kind: string) {
  if (kind.startsWith("paypal.webhook")) return "PayPal event";
  if (kind.startsWith("paypal.event")) return "Event processing";
  if (kind.startsWith("paypal.connection")) return "PayPal connection";
  if (kind.startsWith("paypal.")) return "PayPal action";
  if (kind.startsWith("auth.")) return "Sign-in";
  if (kind.startsWith("ai.")) return "AI analysis";
  if (kind.startsWith("policy.")) return "Policy";
  if (kind.startsWith("approval.")) return "Approval";
  if (kind.startsWith("workspace.")) return "Workspace";
  if (kind.startsWith("action.")) return "PayPal action";
  if (kind.startsWith("budget.")) return "Budget";
  if (kind.startsWith("authority.")) return "Authority";
  if (kind.startsWith("agent.")) return "AI agent";
  if (kind.startsWith("node.")) return "Workflow step";
  if (kind.startsWith("run.")) return "Workflow run";
  if (kind.startsWith("workflow.")) return "Workflow";
  if (kind === "simulation.observed" || kind.startsWith("observe.")) return "Observe Mode";
  if (kind.startsWith("simulation.")) return "Test run";
  if (kind.startsWith("demo.")) return "Demo setup";
  if (kind.startsWith("user.")) return "Account";
  return kind;
}

function dotFor(actor: string) {
  if (actor === "paypal") return "bg-ink border-ink";
  if (actor.startsWith("ai:")) return "bg-marker border-marker";
  if (actor.startsWith("user:")) return "bg-surface border-ink";
  return "bg-surface border-line-strong";
}

const PAGE = 200;

export default async function AuditPage(props: PageProps<"/audit">) {
  const user = await requireUser();
  const params = await props.searchParams;
  // Search by request reference, PayPal id, run id or words in the summary; page back with ?before=<seq>.
  const q = (typeof params.q === "string" ? params.q : "").trim().slice(0, 80);
  const before = typeof params.before === "string" && /^\d{1,12}$/.test(params.before) ? Number(params.before) : null;
  // ILIKE wildcards in the search text are literal.
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = and(
    eq(auditRecords.workspaceId, user.workspaceId),
    q ? or(ilike(auditRecords.summary, like), ilike(auditRecords.paypalRef, like), sql`${auditRecords.runId}::text = ${q}`, sql`${auditRecords.payload}::text ilike ${like}`) : undefined,
    before !== null ? lt(auditRecords.seq, before) : undefined,
  );
  const [records, chain] = await Promise.all([
    db().select().from(auditRecords).where(where).orderBy(desc(auditRecords.seq)).limit(PAGE),
    verifyChain(user.workspaceId),
  ]);
  const older = records.length === PAGE ? `/audit?${new URLSearchParams({ ...(q ? { q } : {}), before: String(records[records.length - 1].seq) })}` : null;

  // Group by calendar day, newest first.
  const days = new Map<string, typeof records>();
  for (const r of records) {
    const key = r.at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    days.set(key, [...(days.get(key) ?? []), r]);
  }

  return (
    <>
      <PageHeader
        title="Audit"
        lead="Every decision, approval and PayPal call, in an append-only hash chain."
        actions={
          chain.ok ? (
            <div className="text-right">
              <Status tone="ok">Chain intact · {chain.records} records</Status>
              <div className="mt-1">
                <CopyId value={chain.head} display={`head ${chain.head.slice(0, 12)}…`} />
              </div>
            </div>
          ) : (
            <Status tone="danger">
              Chain broken at #{chain.brokenAtSeq} — {chain.reason}
            </Status>
          )
        }
      />

      <form action="/audit" className="mb-10 flex max-w-xl items-end gap-3" role="search">
        <label className="block flex-1">
          <span className="pf-label">Find</span>
          <input
            name="q"
            defaultValue={q}
            placeholder="request PF-…, PayPal id, run id or words"
            className="mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink"
          />
        </label>
        <button type="submit" className={buttonClass("secondary")}>
          Search
        </button>
        {(q || before !== null) && (
          <Link href="/audit" className="pb-1.5 text-body-sm text-muted hover:text-ink">
            Latest
          </Link>
        )}
      </form>

      {records.length === 0 &&
        (q || before !== null ? (
          <Empty>No records match. The chain itself is verified above, whatever is shown.</Empty>
        ) : (
          <Empty>Nothing recorded yet. Every decision, approval and PayPal call will appear here, in a hash-chained log.</Empty>
        ))}

      {[...days.entries()].map(([day, rows]) => (
        <section key={day} className="mb-12">
          <h2 className="pf-label mb-4">{day}</h2>
          <ol className="relative">
            <span aria-hidden className="absolute bottom-3 left-[83px] top-3 w-px bg-line" />
            {rows.map((r) => (
              <li key={r.id} className="relative grid grid-cols-[72px_24px_1fr] items-start gap-x-0 pb-6 last:pb-0">
                <time className="pt-0.5 font-mono text-meta text-muted" dateTime={r.at.toISOString()}>
                  {formatClock(r.at)}
                </time>
                <span aria-hidden className={`relative z-10 mt-1.5 ml-[7px] size-[9px] rounded-full border-[1.5px] ${dotFor(r.actor)}`} />
                <details className="group min-w-0">
                  <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <div className="pf-label text-ink">{headingFor(r.kind)}</div>
                      <div className="mt-0.5 text-body text-ink-2">{r.summary}</div>
                      {r.paypalRef && <div className="mt-1 font-mono text-meta text-muted">{r.paypalRef}</div>}
                    </div>
                    <ChevronRight
                      size={14}
                      aria-hidden
                      className="mt-0.5 shrink-0 text-faint transition-transform duration-[var(--pf-dur-fast)] group-open:rotate-90"
                    />
                  </summary>
                  <div className="mt-3 border-l-2 border-line pl-4 animate-fade-up">
                    <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 text-meta">
                      <dt className="text-muted">Record</dt>
                      <dd className="font-mono">#{r.seq} · {r.kind}</dd>
                      <dt className="text-muted">Actor</dt>
                      <dd className="font-mono">{r.actor}</dd>
                      <dt className="text-muted">Hash</dt>
                      <dd><CopyId value={r.hash} display={`${r.hash.slice(0, 24)}…`} /></dd>
                      <dt className="text-muted">Previous</dt>
                      <dd><CopyId value={r.prevHash} display={r.prevHash === "GENESIS" ? "GENESIS" : `${r.prevHash.slice(0, 24)}…`} /></dd>
                      {r.paypalRef && (
                        <>
                          <dt className="text-muted">PayPal ref</dt>
                          <dd><CopyId value={r.paypalRef} /></dd>
                        </>
                      )}
                    </dl>
                    {Object.keys(r.payload as object).length > 0 && (
                      <pre className="mt-3 max-h-72 overflow-auto rounded-sm bg-sunken p-3 font-mono text-meta leading-5 text-ink-2">
                        {JSON.stringify(r.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {older && (
        <Link href={older} className={buttonClass("quiet")}>
          Older records →
        </Link>
      )}
    </>
  );
}
