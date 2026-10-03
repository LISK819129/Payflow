import { and, count, desc, eq, sql } from "drizzle-orm";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { CopyId, Empty, ProvenanceTag, Section, formatClock, formatDay, formatMoney, greeting } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { integrationStatus } from "@/server/config/env";
import { db } from "@/server/db/client";
import { auditRecords, paypalEvents } from "@/server/db/schema";

export default async function HomePage() {
  const user = await requireUser();
  const status = integrationStatus();
  const ws = user.workspaceId;

  const [[processed], recentAudit, recentEvents] = await Promise.all([
    // Real captured volume, from verified PayPal events only.
    db()
      .select({
        total: sql<string>`coalesce(sum((${paypalEvents.raw}->'resource'->'amount'->>'value')::numeric), 0)::text`,
      })
      .from(paypalEvents)
      .where(
        and(
          eq(paypalEvents.workspaceId, ws),
          eq(paypalEvents.eventType, "PAYMENT.CAPTURE.COMPLETED"),
          eq(paypalEvents.provenance, "REAL_PAYPAL_SANDBOX"),
          sql`${paypalEvents.raw}->'resource'->'amount'->>'currency_code' = 'USD'`,
        ),
      ),
    db().select().from(auditRecords).where(eq(auditRecords.workspaceId, ws)).orderBy(desc(auditRecords.seq)).limit(9),
    db().select().from(paypalEvents).where(eq(paypalEvents.workspaceId, ws)).orderBy(desc(paypalEvents.receivedAt)).limit(5),
  ]);
  const [{ n: eventCount }] = await db().select({ n: count() }).from(paypalEvents).where(eq(paypalEvents.workspaceId, ws));

  const activeFlows: number = 0; // workflow engine: Phase 3
  const attention: number = 0; // approvals: Phase 6
  const headline = !status.paypal.configured
    ? "PayPal isn't connected yet."
    : activeFlows === 0
      ? "PayPal is connected. No flows are running yet."
      : attention > 0
        ? `${attention} thing${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} your attention.`
        : "Your money is behaving normally.";

  return (
    <div className="animate-fade-up">
      <p className="text-lead text-muted">{greeting()}</p>
      <h1 className="mt-1 max-w-3xl text-headline font-semibold tracking-[-0.02em]">{headline}</h1>

      <dl className="mt-8 flex flex-wrap gap-x-12 gap-y-4">
        <Figure label="processed" value={formatMoney(processed.total)} />
        <Figure label="active flows" value={String(activeFlows)} />
        <Figure label="need attention" value={String(attention)} />
        <Figure label="PayPal events" value={String(eventCount)} />
      </dl>

      <div className="mt-14 grid gap-x-16 gap-y-12 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-12">
          <Section label="Live flows">
            <Empty>No flows yet. The Flow Builder arrives in Phase 3.</Empty>
          </Section>
          <Section label="Needs attention">
            <Empty>Nothing needs you.</Empty>
          </Section>
          <Section
            label="Latest PayPal events"
            aside={
              <Link href="/events" className="inline-flex items-center gap-1 hover:text-ink">
                All events <ArrowRight size={12} aria-hidden />
              </Link>
            }
          >
            {recentEvents.length === 0 ? (
              <Empty>No PayPal events received yet.</Empty>
            ) : (
              <ul>
                {recentEvents.map((e) => (
                  <li key={e.id} className="flex items-center gap-4 border-b border-line py-3 last:border-b-0">
                    <span className="w-16 shrink-0 font-mono text-meta text-faint">{formatClock(e.receivedAt)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium">{e.eventType}</span>
                      {e.resourceId && <CopyId value={e.resourceId} />}
                    </span>
                    <ProvenanceTag value={e.provenance} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <Section
          label="Recent activity"
          aside={
            <Link href="/audit" className="inline-flex items-center gap-1 hover:text-ink">
              Audit <ArrowRight size={12} aria-hidden />
            </Link>
          }
        >
          {recentAudit.length === 0 ? (
            <Empty>No activity yet.</Empty>
          ) : (
            <ol>
              {recentAudit.map((r) => (
                <li key={r.id} className="flex gap-4 border-b border-line py-2.5 last:border-b-0">
                  <span className="w-16 shrink-0 pt-px font-mono text-meta text-faint" title={formatDay(r.at)}>
                    {formatClock(r.at)}
                  </span>
                  <span className="min-w-0 text-body text-ink-2">{r.summary}</span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="text-title font-semibold tracking-[-0.01em]">{value}</dd>
      <dt className="text-body-sm text-muted">{label}</dt>
    </div>
  );
}
