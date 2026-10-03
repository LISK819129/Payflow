import { count, desc, eq } from "drizzle-orm";
import { Badge, Card, EmptyState, PageHeader, formatTime } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { integrationStatus } from "@/server/config/env";
import { db } from "@/server/db/client";
import { auditRecords, paypalEvents } from "@/server/db/schema";

export default async function DashboardPage() {
  const user = await requireUser();
  const status = integrationStatus();
  const [[events], [audits], recent] = await Promise.all([
    db().select({ n: count() }).from(paypalEvents).where(eq(paypalEvents.workspaceId, user.workspaceId)),
    db().select({ n: count() }).from(auditRecords).where(eq(auditRecords.workspaceId, user.workspaceId)),
    db()
      .select()
      .from(auditRecords)
      .where(eq(auditRecords.workspaceId, user.workspaceId))
      .orderBy(desc(auditRecords.seq))
      .limit(8),
  ]);

  const integrations = [
    { name: "PayPal Sandbox API", s: status.paypal, note: "OAuth client credentials for the PixelForge sandbox app" },
    { name: "PayPal webhooks", s: status.paypalWebhooks, note: "Webhook ID used to verify event signatures" },
    { name: "AI provider", s: status.ai, note: "Workflow compiler and analysis nodes" },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description={user.workspaceName} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="PayPal events received" value={events.n} />
        <Stat label="Audit records" value={audits.n} />
        <Stat label="Active workflows" value={0} hint="Workflow engine lands in Phase 3" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Integrations">
          <ul className="divide-y divide-border">
            {integrations.map((i) => (
              <li key={i.name} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div>
                  <div className="text-sm font-medium">{i.name}</div>
                  <div className="text-xs text-muted">{i.note}</div>
                  {!i.s.configured && (
                    <div className="mt-1 font-mono text-[11px] text-faint">missing: {i.s.missing.join(", ")}</div>
                  )}
                </div>
                {i.s.configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="warn">Setup required</Badge>}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recent activity">
          {recent.length === 0 ? (
            <EmptyState>No activity yet.</EmptyState>
          ) : (
            <ol className="space-y-2">
              {recent.map((r) => (
                <li key={r.id} className="flex gap-3 text-sm">
                  <span className="num w-32 shrink-0 font-mono text-xs text-faint">{formatTime(r.at)}</span>
                  <span className="min-w-0">{r.summary}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}
