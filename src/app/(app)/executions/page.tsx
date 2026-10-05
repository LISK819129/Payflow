import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { runLabel, runTone } from "@/components/flow/run-status";
import { Empty, PageHeader, ProvenanceTag, Status, formatClock, formatDay, formatMoney } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { listRuns } from "@/server/workflow/queries";

export default async function ExecutionsPage() {
  const user = await requireUser();
  const runs = await listRuns(user.workspaceId);
  return (
    <>
      <PageHeader title="Executions" lead="Every run, the version it ran on, what started it and how it ended." />
      {runs.length === 0 ? (
        <Empty>No runs yet. Runs start when an active flow&rsquo;s trigger fires — a PayPal event, a schedule, a person, or an AI agent&rsquo;s request. To try a flow without moving money, use “Test this flow”.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr className="border-b border-line">
                {["Started", "Flow", "Trigger", "Amount", "Status", "Source", ""].map((h) => (
                  <th key={h} scope="col" className="pf-label py-2 pr-6 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const amount = (r.triggerPayload as { amount?: { value?: string; currency_code?: string } }).amount;
                return (
                  <tr key={r.id} className="group border-b border-line align-top hover:bg-sunken/60">
                    <td className="whitespace-nowrap py-3 pr-6 font-mono text-meta text-muted">
                      {formatDay(r.startedAt)} {formatClock(r.startedAt)}
                    </td>
                    <td className="py-3 pr-6">
                      <div className="text-body font-medium">{r.workflowName}</div>
                      <div className="text-meta text-muted">v{r.version}</div>
                    </td>
                    <td className="py-3 pr-6">
                      <div className="text-body-sm">{r.triggerKind.replace("_", " ")}</div>
                      <div className="max-w-52 truncate font-mono text-meta text-faint">{r.triggerRef}</div>
                    </td>
                    <td className="py-3 pr-6 text-body font-medium">{amount?.value ? formatMoney(amount.value, amount.currency_code ?? "USD") : "—"}</td>
                    <td className="py-3 pr-6">
                      <Status tone={runTone[r.status] ?? "neutral"}>{runLabel(r.status)}</Status>
                    </td>
                    <td className="py-3 pr-6">
                      <ProvenanceTag value={r.provenance} />
                    </td>
                    <td className="py-3">
                      <Link href={`/executions/${r.id}`} className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
                        Open <ArrowRight size={13} aria-hidden />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
