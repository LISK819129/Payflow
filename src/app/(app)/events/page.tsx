import { desc, eq } from "drizzle-orm";
import { CopyId, Empty, PageHeader, ProvenanceTag, Status, formatClock, formatDay } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { paypalEvents } from "@/server/db/schema";

const verificationLabel: Record<string, string> = {
  SELF: "Signature verified",
  POSTBACK: "Verified by PayPal",
  SIMULATOR: "Simulator signature",
};

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
      <PageHeader title="PayPal events" lead="Webhook deliveries from PayPal that passed signature verification. Each is stored once, however many times PayPal delivers it." />
      {events.length === 0 ? (
        <Empty>No PayPal events yet. They appear here once the sandbox webhook is registered.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-line">
                {["Received", "Event", "PayPal resource", "Authenticity", "Deliveries", "Source"].map((h) => (
                  <th key={h} scope="col" className="pf-label py-2 pr-6 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-line align-top transition-colors duration-[var(--pf-dur-fast)] hover:bg-sunken/60">
                  <td className="whitespace-nowrap py-3 pr-6 font-mono text-meta text-muted">
                    {formatDay(e.receivedAt)} {formatClock(e.receivedAt)}
                  </td>
                  <td className="py-3 pr-6">
                    <div className="text-body font-medium">{e.eventType}</div>
                    <CopyId value={e.eventId} className="text-muted" />
                  </td>
                  <td className="py-3 pr-6">{e.resourceId ? <CopyId value={e.resourceId} /> : <span className="text-faint">—</span>}</td>
                  <td className="py-3 pr-6">
                    <Status tone={e.verification === "SIMULATOR" ? "neutral" : "ok"}>{verificationLabel[e.verification] ?? e.verification}</Status>
                  </td>
                  <td className="py-3 pr-6 font-mono text-meta">{e.deliveries}</td>
                  <td className="py-3">
                    <ProvenanceTag value={e.provenance} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
