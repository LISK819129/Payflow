import { desc, eq } from "drizzle-orm";
import { Badge, Card, EmptyState, PageHeader, formatTime } from "@/components/ui";
import { verifyChain } from "@/server/audit/audit";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { auditRecords } from "@/server/db/schema";

export default async function AuditPage() {
  const user = await requireUser();
  const [records, verification] = await Promise.all([
    db()
      .select()
      .from(auditRecords)
      .where(eq(auditRecords.workspaceId, user.workspaceId))
      .orderBy(desc(auditRecords.seq))
      .limit(200),
    verifyChain(user.workspaceId),
  ]);

  return (
    <>
      <PageHeader
        title="Audit"
        description="Append-only, hash-chained record of every decision, approval and PayPal call."
        actions={
          verification.ok ? (
            <Badge tone="ok">Chain verified · {verification.records} records</Badge>
          ) : (
            <Badge tone="danger">
              Chain broken at #{verification.brokenAtSeq}: {verification.reason}
            </Badge>
          )
        }
      />
      <Card>
        {records.length === 0 ? (
          <EmptyState>No audit records.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-medium">#</th>
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">Actor</th>
                  <th className="py-2 pr-4 font-medium">Event</th>
                  <th className="py-2 pr-4 font-medium">Summary</th>
                  <th className="py-2 font-medium">Hash</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 align-top">
                    <td className="num py-2 pr-4 font-mono text-xs text-faint">{r.seq}</td>
                    <td className="num whitespace-nowrap py-2 pr-4 font-mono text-xs">{formatTime(r.at)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted">{r.actor}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.kind}</td>
                    <td className="py-2 pr-4">{r.summary}</td>
                    <td className="py-2 font-mono text-[11px] text-faint" title={r.hash}>
                      {r.hash.slice(0, 10)}…
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
