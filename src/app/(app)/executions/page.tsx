import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { runLabel, runTone } from "@/components/flow/run-status";
import { Empty, PageHeader, ProvenanceTag, Status, formatClock, formatDay, formatMoney } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { inArray } from "drizzle-orm";
import { settlementsFor } from "@/server/actions/settlement";
import { db } from "@/server/db/client";
import { actionExecutions } from "@/server/db/schema";
import { listRuns } from "@/server/workflow/queries";

export default async function ExecutionsPage() {
  const user = await requireUser();
  const runs = await listRuns(user.workspaceId);
  // What PayPal actually reported for each run's money action — "completed" means the run finished, not that money settled.
  const execs = runs.length ? await db().select().from(actionExecutions).where(inArray(actionExecutions.runId, runs.map((r) => r.id))) : [];
  const settled = await settlementsFor(user.workspaceId, execs);
  const paypalFor = new Map(execs.filter((e) => e.kind.startsWith("paypal.")).map((e) => [e.runId, settled.get(e.id)?.label ?? null]));
  return (
    <>
      <PageHeader title="Executions" lead="Every run of a workflow: what started it, the version it ran on, how it ended — and what PayPal reported for any money it moved." />
      {runs.length === 0 ? (
        <Empty>No runs yet. Runs start when an active workflow&rsquo;s trigger fires — a PayPal event, a schedule, a person, or an AI agent&rsquo;s request. To see what a workflow would decide without contacting PayPal, use a Test run.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr className="border-b border-line">
                {["Started", "Workflow", "Trigger", "Amount", "Status", "Source", ""].map((h) => (
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
                      {paypalFor.get(r.id) && <div className="mt-1 whitespace-nowrap text-meta text-muted">PayPal: {paypalFor.get(r.id)}</div>}
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
