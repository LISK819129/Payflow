import { ArrowRight, Ban, Bot } from "lucide-react";
import Link from "next/link";
import { RegisterAgent } from "@/components/agents/register-agent";
import { ago, RequestState } from "@/components/agents/request-state";
import { Empty, formatClock, formatDay, PageHeader } from "@/components/ui";
import { listAgents } from "@/server/agents/queries";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { workflowVersions, workflows } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";

export const dynamic = "force-dynamic";

const CANNOT = ["Approve", "Edit authority", "Edit workflow", "Call PayPal", "See secrets"];

/** Active workflows whose active version starts with an Agent request trigger, and what they can carry out. */
async function agentWorkflows(workspaceId: string) {
  const rows = await db()
    .select({ id: workflows.id, name: workflows.name, graph: workflowVersions.graph })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.activeVersionId))
    .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.state, "ACTIVE")));
  return rows.flatMap((r) => {
    const g = r.graph as WorkflowGraph;
    const t = g.nodes.find((n) => n.type === "trigger.agent_request");
    if (!t) return [];
    const declared = (t.config as { actions?: string[] }).actions ?? ["paypal.payout", "paypal.refund"];
    const actions = (["paypal.payout", "paypal.refund"] as const).filter((a) => declared.includes(a) && g.nodes.some((n) => n.type === a));
    return actions.length ? [{ id: r.id, name: r.name, actions: [...actions] }] : [];
  });
}

export default async function AgentsPage() {
  const user = await requireUser();
  const [list, options] = await Promise.all([listAgents(user.workspaceId), agentWorkflows(user.workspaceId)]);
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Agents"
        lead="External AI agents that may ask PayFlow to move money — through PayFlow's MCP server, never straight to PayPal. The agent asks; PayFlow decides; PayPal settles."
      />

      <ol className="mb-10 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-meta text-muted" aria-label="How an agent request is handled">
        {["AI agent", "MCP", "identity", "scope", "intent receipt", "authority", "intelligence", "person if needed", "PayPal"].map((s, i, a) => (
          <li key={s} className="inline-flex items-center gap-2">
            <span className={i === 0 || i === a.length - 1 ? "text-ink" : ""}>{s}</span>
            {i < a.length - 1 && <ArrowRight size={11} aria-hidden />}
          </li>
        ))}
      </ol>

      {user.role === "OWNER" && (
        <div className="mb-12">
          <RegisterAgent workflows={options} />
        </div>
      )}

      {list.length === 0 ? (
        <Empty>No agents yet.</Empty>
      ) : (
        <div className="space-y-10">
          {list.map((a) => {
            const expired = !!a.expiresAt && a.expiresAt <= now;
            const active = a.status === "ACTIVE" && !expired;
            return (
              <article key={a.id} className={`border-t-2 ${active ? "border-ink" : "border-line-strong"} bg-surface px-6 py-6`} aria-label={`Agent ${a.name}`}>
                <header className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Bot size={18} aria-hidden className="text-muted" />
                      <h2 className="text-title font-semibold">
                        <Link href={`/agents/${a.id}`} className="hover:underline">
                          {a.name}
                        </Link>
                      </h2>
                      {active ? (
                        <span className="inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.08em] text-ink">
                          <span aria-hidden className="size-2 rounded-full bg-marker" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.08em] text-muted">
                          <Ban size={12} aria-hidden /> {a.status === "REVOKED" ? "Revoked" : "Expired"}
                        </span>
                      )}
                    </div>
                    {a.description && <p className="mt-1 text-body-sm text-muted">{a.description}</p>}
                  </div>
                  <span className="font-mono text-meta text-muted">
                    pfa_{a.credentialId}_… · v{a.credentialVersion}
                  </span>
                </header>

                <dl className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="pf-label">Can request</dt>
                    <dd className="mt-1.5 space-y-1 text-body">
                      {a.scopeNames.map((s) => (
                        <div key={s.workflowId}>
                          <span className="font-medium text-ink">{s.name}</span> → {s.actions.map((x) => `${x.replace("paypal.", "")}s`).join(", ")}
                          <div className="font-mono text-meta text-muted">{s.modes.join(" + ")}</div>
                        </div>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt className="pf-label">Cannot</dt>
                    <dd className="mt-1.5 text-body text-ink-2">{CANNOT.join(" · ")}</dd>
                  </div>
                  <div>
                    <dt className="pf-label">Last request</dt>
                    <dd className="mt-1.5 text-body">{a.recent[0] ? ago(a.recent[0].createdAt, now) : "none yet"}</dd>
                    <dd className="font-mono text-meta text-muted">last call {ago(a.lastUsedAt, now)}</dd>
                  </div>
                  <div>
                    <dt className="pf-label">Access</dt>
                    <dd className="mt-1.5 text-body">{a.status === "REVOKED" ? `revoked ${a.revokedAt ? formatDay(a.revokedAt) : ""}` : a.expiresAt ? `until ${formatDay(a.expiresAt)}` : "until revoked"}</dd>
                  </div>
                </dl>

                <div className="mt-6">
                  <div className="pf-label">Recent activity</div>
                  {a.recent.length === 0 ? (
                    <p className="mt-2 text-body-sm text-muted">No requests yet.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line border-y border-line">
                      {a.recent.map((r) => {
                        const e = r.envelope as { action: string; amount: { value: string; currency: string }; counterparty: string | null; captureId: string | null };
                        return (
                          <li key={r.id}>
                            <Link href={`/agents/requests/${r.reference}`} className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 hover:bg-sunken/60 sm:grid-cols-[150px_110px_minmax(0,1fr)_auto]">
                              <span className="font-mono text-meta text-muted">
                                {formatDay(r.createdAt)} {formatClock(r.createdAt)}
                              </span>
                              <span className="hidden font-mono text-meta text-ink sm:inline">{r.reference}</span>
                              <span className="truncate text-body">
                                {r.mode === "TEST" && <span className="mr-1.5 font-mono text-meta text-sim">TEST</span>}
                                {e.action.replace("paypal.", "")} {e.amount.value} {e.amount.currency} → {e.counterparty ?? e.captureId}
                              </span>
                              <RequestState state={r.state} />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
