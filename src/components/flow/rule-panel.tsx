"use client";

import { ArrowRight, Bot, CalendarClock, Radio, UserRound } from "lucide-react";
import Link from "next/link";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { effectivePermission, money, summarizeRule, type AuthorityTerms } from "@/server/workflow/rule-summary";

/**
 * "This rule" — what a person needs before the graph: where requests come from,
 * what it may pay without a person (workflow vs authority), and what to do next.
 * Descriptive only; every request is still checked in full by the engine.
 */
export function RulePanel({
  workflowId,
  workflowName,
  graph,
  state,
  latestStatus,
  latestVersion,
  authorities,
  agentCount,
  isOwner,
  onTest,
}: {
  workflowId: string;
  workflowName: string;
  graph: WorkflowGraph;
  state: string;
  latestStatus: string;
  latestVersion: number;
  authorities: AuthorityTerms[];
  agentCount: number;
  isOwner: boolean;
  onTest: () => void;
}) {
  const rule = summarizeRule(graph);
  const eff = effectivePermission(rule, authorities);
  const active = state === "ACTIVE";
  const draftPending = latestStatus === "DRAFT";

  return (
    <section aria-labelledby="rule-h" className="mb-8">
      <div className="flex items-center justify-between">
        <h2 id="rule-h" className="pf-label text-ink">
          This rule
        </h2>
        <span className={`rounded-sm px-1.5 py-px text-label font-semibold uppercase tracking-[0.06em] ${active ? "bg-ok-wash text-ok" : "border border-line-strong text-muted"}`}>{active ? "Active" : state === "PAUSED" ? "Paused" : state === "FROZEN" ? "Frozen" : "Draft — not active"}</span>
      </div>

      {/* 1. Where requests come from */}
      <div className="mt-4">
        <div className="pf-label">Requests come from</div>
        {rule.source === "agent" && (
          <div className="mt-1.5 text-body-sm">
            <p className="flex items-start gap-2 text-ink">
              <Bot size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>AI agents, through PayFlow&rsquo;s MCP gateway</span>
            </p>
            <p className="mt-1 text-muted">
              {agentCount === 0 ? "No agent may ask through it yet." : `${agentCount} agent${agentCount === 1 ? "" : "s"} may ask through it.`} An agent gets permission to <em>ask</em>; every request is still checked against this rule and its authority.
            </p>
            {rule.unknownAgentFields.length > 0 && (
              <p className="mt-2 rounded-sm border border-warn/40 bg-warn-wash px-3 py-2 text-ink">
                This workflow reads <span className="font-mono text-meta">{rule.unknownAgentFields.map((f) => `trigger.${f}`).join(", ")}</span>, which an agent request doesn&rsquo;t carry. Agent requests carry <span className="font-mono text-meta">trigger.counterparty</span> (the recipient), <span className="font-mono text-meta">trigger.amount</span>, <span className="font-mono text-meta">trigger.purpose</span> and <span className="font-mono text-meta">trigger.invoice</span>. Until the steps read those, every request would stop for missing data and go to a person. Select the step and change the field.
              </p>
            )}
            {isOwner && rule.unknownAgentFields.length === 0 && (
              <Link href={`/agents?workflow=${workflowId}#register`} className="mt-1.5 inline-flex items-center gap-1 font-medium text-ink underline underline-offset-4">
                Connect an AI agent <ArrowRight size={12} aria-hidden />
              </Link>
            )}
          </div>
        )}
        {rule.source === "manual" && (
          <div className="mt-1.5 text-body-sm">
            <p className="flex items-start gap-2 text-ink">
              <UserRound size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                A person, with <span className="font-medium">Run manually</span>
                {active ? "" : " (once active)"}
              </span>
            </p>
            <p className="mt-1 text-muted">
              AI agents can&rsquo;t send requests to this rule: it starts when a person runs it. Agents ask only through workflows that start with an <span className="text-ink">Agent request</span> trigger — see{" "}
              <Link href="/agents" className="text-ink underline underline-offset-2">
                Agents
              </Link>{" "}
              for the ones that accept them.
            </p>
          </div>
        )}
        {rule.source === "paypal_event" && (
          <div className="mt-1.5 text-body-sm">
            <p className="flex items-start gap-2 text-ink">
              <Radio size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>PayPal, when it reports {rule.eventTypes.length ? rule.eventTypes.join(", ") : "an event"}</span>
            </p>
            <p className="mt-1 text-muted">Runs on its own for each signed, verified PayPal event{active ? "" : " once active"}.</p>
          </div>
        )}
        {rule.source === "schedule" && (
          <p className="mt-1.5 flex items-start gap-2 text-body-sm text-ink">
            <CalendarClock size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>A schedule{active ? "" : " (once active)"}</span>
          </p>
        )}
      </div>

      {/* 2. Workflow vs authority */}
      {rule.movesMoney && (
        <div className="mt-6">
          <div className="pf-label">Pays without a person when</div>
          {eff.covered ? (
            <dl className="mt-2 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-body-sm">
              <dt className="text-muted">To</dt>
              <dd className="text-ink">{eff.suppliers.list === "any" ? "anyone not on a deny list" : eff.suppliers.list.length ? eff.suppliers.list.map((s) => s.name).join(", ") : "no one"}</dd>
              {eff.currencies && (
                <>
                  <dt className="text-muted">Currency</dt>
                  <dd className="text-ink">{eff.currencies.join(", ") || "none in common"}</dd>
                </>
              )}
              {eff.autoMax && (
                <>
                  <dt className="text-muted">Per payment</dt>
                  <dd className="text-ink">
                    up to {money(eff.autoMax.value, eff.autoMax.currency)}
                    <span className="block text-meta text-muted">{eff.autoMaxFrom === "authority" ? (rule.amountGate ? "set by the authority (the workflow allows more)" : "set by the authority") : eff.autoMaxFrom === "workflow" ? "set by the workflow (its authority allows more)" : "workflow and authority agree"}</span>
                  </dd>
                </>
              )}
              {eff.purpose && (
                <>
                  <dt className="text-muted">For</dt>
                  <dd className="line-clamp-3 text-ink" title={eff.purpose}>
                    {eff.purpose}
                  </dd>
                </>
              )}
              {eff.budget && (
                <>
                  <dt className="text-muted">Budget</dt>
                  <dd className="text-ink">{eff.budget}</dd>
                </>
              )}
              {eff.suppliers.denied.length > 0 && (
                <>
                  <dt className="text-muted">Never</dt>
                  <dd className="text-danger">{eff.suppliers.denied.join(", ")}</dd>
                </>
              )}
            </dl>
          ) : (
            <div className="mt-2 rounded-sm border border-warn/40 bg-warn-wash px-3 py-2 text-body-sm text-ink">
              No authority covers this workflow yet, so <span className="font-medium">every payment it asks for waits for a person</span> — even one its own rules allow.
              {isOwner && (
                <Link href={`/authority/new?workflow=${workflowId}`} className="mt-1 flex items-center gap-1 font-medium underline underline-offset-4">
                  Create an authority for {workflowName} <ArrowRight size={12} aria-hidden />
                </Link>
              )}
            </div>
          )}
          {eff.purposeMismatch && (
            <div className="mt-2 rounded-sm border border-warn/40 bg-warn-wash px-3 py-2 text-body-sm text-ink">
              <span className="font-medium">Purpose wording differs, so every payment will wait for a person.</span> This workflow checks purpose against &ldquo;{eff.purposeMismatch.workflow}&rdquo;, but its authority is delegated for &ldquo;{eff.purposeMismatch.authority.length > 90 ? `${eff.purposeMismatch.authority.slice(0, 90)}…` : eff.purposeMismatch.authority}&rdquo;. An authority only accepts a purpose check made against its own exact wording. Make the two identical — edit the authority&rsquo;s <em>For what</em>, or clear the wording on the purpose step so it uses the authority&rsquo;s.
            </div>
          )}
          {eff.suppliers.outsideAuthority.length > 0 && <p className="mt-2 text-meta text-warn">Named by the workflow but not in its authority: {eff.suppliers.outsideAuthority.join(", ")} — a person decides those.</p>}
          <p className="mt-3 text-meta text-muted">
            The <span className="text-ink">workflow</span> says what should happen. Its <span className="text-ink">authority</span> says what it is permitted to do — the ceiling for paying without a person. The stricter of the two applies; anything outside goes to a person, and anything an authority forbids is refused.{" "}
            <Link href="/authority" className="text-ink underline underline-offset-2">
              Authorities
            </Link>
          </p>
        </div>
      )}

      {/* 3. Next steps */}
      {(draftPending || !active) && (
        <div className="mt-6">
          <div className="pf-label">Next</div>
          <ol className="mt-2 space-y-2 text-body-sm">
            <li className="flex gap-2">
              <span className="font-mono text-meta text-faint">1</span>
              <span>
                <button type="button" onClick={onTest} className="font-medium text-ink underline underline-offset-4">
                  Test it
                </button>{" "}
                <span className="text-muted">— see each decision; PayPal is not contacted.</span>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-meta text-faint">2</span>
              <span>
                <span className="font-medium text-ink">Activate v{latestVersion}</span> <span className="text-muted">— top right. Nothing runs until you do.</span>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-meta text-faint">3</span>
              <span>
                <span className="font-medium text-ink">{rule.source === "agent" ? "Connect an AI agent" : rule.source === "manual" ? "Run it manually" : rule.source === "paypal_event" ? "Wait for PayPal events" : "Let it run"}</span>
                {rule.movesMoney && !eff.covered && <span className="text-muted"> — and give it an authority first, or every payment waits for a person.</span>}
              </span>
            </li>
          </ol>
        </div>
      )}
    </section>
  );
}
