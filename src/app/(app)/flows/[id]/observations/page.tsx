import { and, eq } from "drizzle-orm";
import { ArrowLeft, ArrowRight, Eye } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Empty, formatClock, formatDay, PageHeader, Section } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { money } from "@/server/authority/evaluate";
import { db } from "@/server/db/client";
import { workflows } from "@/server/db/schema";
import { listSimulations } from "@/server/simulation/queries";

const LABEL: Record<string, { text: string; cls: string }> = {
  WOULD_ALLOW: { text: "Would continue automatically", cls: "text-marker-ink" },
  WOULD_REVIEW: { text: "Would require review", cls: "text-warn" },
  WOULD_DENY: { text: "Would be denied", cls: "text-danger" },
  WOULD_END: { text: "Would end without PayPal", cls: "text-ink-2" },
  WOULD_WAIT: { text: "Would wait", cls: "text-ink-2" },
  WOULD_SUSPEND: { text: "Would be suspended", cls: "text-warn" },
  ERROR: { text: "Could not evaluate", cls: "text-danger" },
};

export default async function ObservationsPage(props: PageProps<"/flows/[id]/observations">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [wf] = await db().select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.workspaceId, user.workspaceId)));
  if (!wf) notFound();
  const rows = await listSimulations(user.workspaceId, id, "OBSERVE", 200);
  const count = (v: string) => rows.filter((r) => r.verdict === v).length;

  return (
    <>
      <Link href={`/flows/${id}`} className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> {wf.name}
      </Link>
      <div className="mt-4">
        <PageHeader
          title="Observe Mode"
          lead="This draft evaluates real incoming PayPal events exactly as it would if it were active — but it has no ability to move money, reserve budget, create approvals or contact anyone."
        />
      </div>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        {wf.observing ? (
          <span className="inline-flex items-center gap-2 bg-ink px-2.5 py-1 text-label font-semibold uppercase tracking-[0.08em] text-surface">
            <span aria-hidden className="animate-live-dot inline-block size-2 rounded-full bg-marker" /> Observing — cannot move money or contact anyone
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 border border-line-strong px-2.5 py-1 text-label font-semibold uppercase tracking-[0.08em] text-muted">
            <Eye size={13} aria-hidden /> Not observing
          </span>
        )}
        {wf.observingSince && <span className="font-mono text-meta text-muted">since {formatDay(wf.observingSince)} {formatClock(wf.observingSince)}</span>}
      </div>

      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[
          ["Real events observed", rows.length, "text-ink"],
          ["Would continue automatically", count("WOULD_ALLOW") + count("WOULD_END"), "text-marker-ink"],
          ["Would require review", count("WOULD_REVIEW"), "text-warn"],
          ["Would be denied", count("WOULD_DENY"), "text-danger"],
        ].map(([label, n, cls]) => (
          <div key={label as string} className="border-t-2 border-ink pt-3">
            <div className="pf-label">{label}</div>
            <div className={`mt-1 text-figure font-semibold tracking-[-0.02em] ${cls}`}>{n}</div>
          </div>
        ))}
      </div>

      <Section label="Observations" aside="each one: the draft version at that moment, the real event, the path" className="mt-10">
        {rows.length === 0 ? (
          <Empty>No matching PayPal event has arrived since observing started.</Empty>
        ) : (
          <ul>
            {rows.map((r) => {
              const t = (r.trigger as { payload: { eventType?: string; amount?: { value: string; currency_code: string } | null; resourceId?: string | null } }).payload;
              const l = LABEL[r.verdict] ?? LABEL.ERROR;
              return (
                <li key={r.id} className="border-b border-line">
                  <Link href={`/simulations/${r.id}`} className="grid grid-cols-[150px_minmax(0,1fr)_auto_20px] items-center gap-4 py-3 hover:bg-sunken/60">
                    <span className="font-mono text-meta text-muted">
                      {formatDay(r.evaluatedAt)} {formatClock(r.evaluatedAt)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-body font-medium text-ink">
                        {t.eventType} {t.amount ? `· ${money(t.amount.value, t.amount.currency_code)}` : ""}
                      </span>
                      <span className="block truncate text-meta text-muted">
                        REAL_PAYPAL_EVENT_OBSERVED · {r.paypalEventId} · draft v{r.versionNumber} · no action taken
                      </span>
                    </span>
                    <span className={`text-label font-semibold uppercase tracking-[0.06em] ${l.cls}`}>{l.text}</span>
                    <ArrowRight size={14} className="text-muted" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <p className="mt-8 max-w-3xl text-body-sm text-muted">
        These describe how this draft evaluated real events with the state available at that moment. They are not predictions: live results can differ if transaction data, authority, budgets, the workflow version, AI analysis or PayPal state change. Editing the draft never changes past observations — each keeps the exact version it used.
      </p>
    </>
  );
}
