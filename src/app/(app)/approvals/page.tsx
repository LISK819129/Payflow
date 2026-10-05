import { Check, CircleX, Clock } from "lucide-react";
import Link from "next/link";
import { ApprovalCard } from "@/components/authority/approval-card";
import { CopyId, Empty, formatClock, formatDay, PageHeader, Section } from "@/components/ui";
import { listApprovals } from "@/server/approvals/queries";
import { ACTION_LABEL, money } from "@/server/authority/evaluate";
import { canAuthorize, requireUser } from "@/server/auth/current";

export const dynamic = "force-dynamic";

const decidedIcon = {
  APPROVED: <Check size={14} strokeWidth={2.25} className="text-marker-ink" aria-hidden />,
  REJECTED: <CircleX size={14} strokeWidth={1.75} className="text-danger" aria-hidden />,
  EXPIRED: <Clock size={14} strokeWidth={1.75} className="text-muted" aria-hidden />,
  PENDING: null,
};

export default async function ApprovalsPage() {
  const user = await requireUser();
  const now = new Date();
  const [pending, decided] = await Promise.all([listApprovals(user.workspaceId, { status: "PENDING" }), listApprovals(user.workspaceId, { status: "DECIDED", limit: 30 })]);
  return (
    <>
      <PageHeader
        title="Approvals"
        lead="Requests a workflow could not make on its own authority. Each decision covers one request, once — approving never widens what a workflow may do."
      />
      {pending.length === 0 ? (
        <Empty>Nothing needs your attention. Requests that go beyond a workflow&rsquo;s delegated authority will wait here for you.</Empty>
      ) : (
        <div className="space-y-10">
          {pending.map((v) => (
            <ApprovalCard key={v.id} v={v} canDecide={canAuthorize(user)} now={now} />
          ))}
        </div>
      )}

      <Section label="Decided" aside={`${decided.length} most recent`} className="mt-14">
        {decided.length === 0 ? (
          <p className="py-4 text-body-sm text-muted">No decisions yet.</p>
        ) : (
          <ul>
            {decided.map((v) => {
              const amt = v.action?.amount;
              return (
                <li key={v.id} className="grid grid-cols-[20px_1fr] gap-x-3 border-b border-line py-3 md:grid-cols-[20px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
                  <span className="mt-0.5">{decidedIcon[v.status]}</span>
                  <div className="min-w-0">
                    <div className="text-body font-medium text-ink">
                      {v.status === "APPROVED" ? "Approved" : v.status === "REJECTED" ? "Rejected" : "Expired"} · {v.action && v.action.kind !== "none" ? `${ACTION_LABEL[v.action.kind] ?? v.action.label} ` : ""}
                      {amt ? money(amt.value, amt.currency) : ""}
                    </div>
                    <div className="truncate text-meta text-muted">{v.action?.counterparty ?? v.reason}</div>
                  </div>
                  <div className="col-start-2 text-body-sm md:col-start-auto">
                    <Link href={`/executions/${v.run.id}`} className="text-ink hover:underline">
                      {v.workflow.name}
                    </Link>
                    <div className="font-mono text-meta text-muted">
                      {v.decidedBy ? `${v.decidedBy} · ` : ""}
                      {v.decidedAt ? `${formatDay(v.decidedAt)} ${formatClock(v.decidedAt)}` : ""}
                    </div>
                  </div>
                  <div className="col-start-2 text-body-sm md:col-start-auto">
                    {v.execution ? (
                      v.execution.failure ? (
                        <span className="text-danger">PayPal refused: {v.execution.failure}</span>
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-1.5 text-ink">
                          PayPal {v.execution.paypalStatus ?? v.execution.status.toLowerCase()}
                          {v.execution.refs[0] && <CopyId value={v.execution.refs[0]} />}
                        </span>
                      )
                    ) : (
                      <span className="text-muted">PayPal not contacted</span>
                    )}
                    {v.note && <div className="text-meta text-muted">“{v.note}”</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}
