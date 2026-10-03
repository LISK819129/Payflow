import { desc, eq } from "drizzle-orm";
import { Card, EmptyState, PageHeader, ProvenanceBadge, formatTime } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { paypalEvents } from "@/server/db/schema";

export default async function EventsPage() {
  const user = await requireUser();
  const events = await db()
    .select()
    .from(paypalEvents)
    .where(eq(paypalEvents.workspaceId, user.workspaceId))
    .orderBy(desc(paypalEvents.receivedAt))
    .limit(100);

  return (
    <>
      <PageHeader title="PayPal events" description="Webhook deliveries that passed signature verification." />
      <Card>
        {events.length === 0 ? (
          <EmptyState>No PayPal events yet. They appear here once the sandbox webhook is registered.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-medium">Received</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Resource</th>
                  <th className="py-2 pr-4 font-medium">Verification</th>
                  <th className="py-2 pr-4 font-medium">Deliveries</th>
                  <th className="py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0">
                    <td className="num whitespace-nowrap py-2 pr-4 font-mono text-xs">{formatTime(e.receivedAt)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{e.eventType}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted">{e.resourceId ?? "—"}</td>
                    <td className="py-2 pr-4 text-xs">{e.verification}</td>
                    <td className="num py-2 pr-4 text-xs">{e.deliveries}</td>
                    <td className="py-2">
                      <ProvenanceBadge value={e.provenance} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
