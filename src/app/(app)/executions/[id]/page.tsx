import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionCard } from "@/components/flow/action-card";
import { DecisionChecks } from "@/components/authority/decision-checks";
import { IntelligencePanel } from "@/components/intelligence/intelligence-panel";
import type { Evaluation } from "@/server/authority/types";
import type { AINodeOutput } from "@/server/intelligence/node";
import { RunGraph } from "@/components/flow/run-graph";
import { CopyId, ProvenanceTag, Section, Status, formatClock, formatMoney } from "@/components/ui";
import { canAuthorize, requireUser } from "@/server/auth/current";
import { SPEC_BY_TYPE, type WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { getRun } from "@/server/workflow/queries";
import { runLabel, runTone } from "@/components/flow/run-status";
import { ApprovalCard } from "@/components/authority/approval-card";
import { listApprovals } from "@/server/approvals/queries";
import { AgentBanner, AgentPipeline } from "@/components/agents/agent-pipeline";
import { getAgentRequestView } from "@/server/agents/queries";
import { settlementsFor } from "@/server/actions/settlement";

export const dynamic = "force-dynamic";

export default async function RunPage(props: PageProps<"/executions/[id]">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getRun(user.workspaceId, id);
  if (!data) notFound();
  const { run, wf, version, steps } = data;
  const agentView = run.triggerKind === "agent_request" ? await getAgentRequestView(user.workspaceId, { runId: run.id }) : null;
  const settlements = await settlementsFor(user.workspaceId, data.actions);
  const graph = version.graph as WorkflowGraph;
  const amount = (run.triggerPayload as { amount?: { value?: string; currency_code?: string } }).amount;
  const pendingRow = data.approvals.find((a) => a.status === "PENDING");
  const pending = pendingRow ? (await listApprovals(user.workspaceId, { status: "PENDING", limit: 200 })).find((v) => v.id === pendingRow.id) : undefined;

  const overlay = Object.fromEntries(
    steps.map((s) => [s.nodeId, { state: s.status === "ERROR" ? ("error" as const) : s.status === "WAITING" ? ("waiting" as const) : ("ok" as const), port: s.port }]),
  );

  return (
    <div className="animate-fade-up">
      <Link href="/executions" className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Executions
      </Link>

      {agentView && (
        <div className="mt-4">
          <AgentBanner v={agentView} />
        </div>
      )}

      <header className="mt-4 flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="pf-label">
            {wf.name} · v{version.version}
          </div>
          <h1 className="mt-1 text-headline font-semibold tracking-[-0.02em]">
            {amount?.value ? formatMoney(amount.value, amount.currency_code ?? "USD") : run.triggerKind.replace("_", " ")}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span data-run-status={run.status}>
              <Status tone={runTone[run.status] ?? "neutral"}>{runLabel(run.status)}</Status>
            </span>
            <ProvenanceTag value={run.provenance} />
            <CopyId value={run.triggerRef} />
          </div>
        </div>
        {run.outcome && <p className="max-w-md text-body text-ink-2">{run.outcome}</p>}
      </header>

      {agentView && (
        <div className="mt-8">
          <AgentPipeline v={agentView} />
          <Link href={`/agents/requests/${agentView.ar.reference}`} className="mt-3 inline-block text-body-sm text-muted hover:text-ink">
            Intent receipt and full request →
          </Link>
        </div>
      )}

      {!pending &&
        (() => {
          const d = data.decisions.at(-1);
          if (!d) return null;
          const snap = (d.authoritySnapshot as { perTransactionMax?: string | null }[] | null) ?? [];
          const human = data.approvals.find((a) => a.nodeId === d.nodeId)?.status ?? null;
          return (
            <div className="mt-8">
              <div className="pf-label mb-2">Why — the authority engine&rsquo;s checks</div>
              <DecisionChecks
                evaluations={d.evaluations as Evaluation[]}
                decision={d.decision}
                amount={(d.request as { amount?: { value: string; currency: string } | null }).amount ?? null}
                limits={snap.map((a) => a.perTransactionMax ?? null)}
                agent={agentView ? { name: agentView.agent.name } : null}
                humanDecision={human}
              />
            </div>
          );
        })()}

      {pending && (
        <div className="mt-8">
          <ApprovalCard v={pending} canDecide={canAuthorize(user)} now={new Date()} />
        </div>
      )}

      {(() => {
        const outputs = steps.filter((s) => SPEC_BY_TYPE[s.nodeType]?.isAI && s.status === "OK" && s.output).map((s) => s.output as AINodeOutput);
        const d = data.decisions.at(-1);
        return outputs.length ? (
          <div className="mt-8">
            <IntelligencePanel outputs={outputs} analyses={data.analyses} decision={d ? { evaluations: d.evaluations as Evaluation[], outcome: d.outcome } : null} />
          </div>
        ) : null;
      })()}

      <div className="mt-10 grid gap-x-12 gap-y-10 xl:grid-cols-[1.25fr_1fr]">
        <Section label="Path through the flow">
          <div className="mt-3 h-[560px] rounded border border-line bg-canvas">
            <RunGraph graph={graph} overlay={overlay} />
          </div>
        </Section>

        <Section label="Timeline" aside={`${steps.length} step${steps.length === 1 ? "" : "s"}`}>
          <ol className="relative mt-4">
            <span aria-hidden className="absolute bottom-3 left-[83px] top-3 w-px bg-line" />
            {steps.map((s) => {
              const spec = SPEC_BY_TYPE[s.nodeType];
              const node = graph.nodes.find((n) => n.id === s.nodeId);
              const dot = s.status === "ERROR" ? "bg-danger border-danger" : s.status === "WAITING" ? "bg-warn border-warn" : spec?.isPolicy ? "bg-ink border-ink" : "bg-marker border-marker";
              return (
                <li key={s.id} className="relative grid grid-cols-[72px_24px_1fr] pb-6 last:pb-0">
                  <time className="pt-0.5 font-mono text-meta text-muted">{formatClock(s.startedAt)}</time>
                  <span aria-hidden className={`relative z-10 ml-[7px] mt-1.5 size-[9px] rounded-full border-[1.5px] ${dot}`} />
                  <div className="min-w-0">
                  <details className="group">
                    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      <div className="pf-label text-ink">{node?.label ?? spec?.title ?? s.nodeType}</div>
                      <div className="mt-0.5 text-body text-ink-2">{s.explanation}</div>
                      {s.port && <div className="mt-0.5 font-mono text-meta text-muted">→ {s.port}</div>}
                    </summary>
                    <div className="mt-2 border-l-2 border-line pl-3">
                      <div className="font-mono text-meta text-muted">
                        #{s.seq} · {s.nodeType} · {s.status}
                      </div>
                      {(s.output != null || s.error != null) && (
                        <pre className="mt-2 max-h-56 overflow-auto rounded-sm bg-sunken p-2 font-mono text-meta text-ink-2">
                          {JSON.stringify(s.error ?? s.output, null, 2)}
                        </pre>
                      )}
                    </div>
                  </details>
                  {data.actions
                    .filter((a) => a.nodeId === s.nodeId)
                    .map((a) => (
                      <ActionCard key={a.id} ex={a} settlement={settlements.get(a.id) ?? null} decision={data.decisions.find((d) => d.id === a.decisionId) ?? null} labels={Object.fromEntries(graph.nodes.map((n) => [n.id, n.label ?? n.id]))} />
                    ))}
                  </div>
                </li>
              );
            })}
          </ol>
          <details className="mt-8">
            <summary className="cursor-pointer text-meta text-muted hover:text-ink">Trigger payload</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-sm bg-sunken p-3 font-mono text-meta text-ink-2">{JSON.stringify(run.triggerPayload, null, 2)}</pre>
          </details>
        </Section>
      </div>
    </div>
  );
}
