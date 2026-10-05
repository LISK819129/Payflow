import { ArrowLeft, CircleAlert, CircleCheck, CircleX, Eye, FlaskConical, Hourglass, Send } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DecisionChecks } from "@/components/authority/decision-checks";
import { DecisionTrace } from "@/components/authority/decision-trace";
import { RunGraph } from "@/components/flow/run-graph";
import { IntelligencePanel } from "@/components/intelligence/intelligence-panel";
import { AssumeButtons } from "@/components/simulation/assume-buttons";
import { formatClock, formatDay, Section } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import type { AuthorityOutcome, BudgetSnapshot, Evaluation, FrequencySnapshot } from "@/server/authority/types";
import { money } from "@/server/authority/evaluate";
import { getSimulation } from "@/server/simulation/queries";
import type { AINodeOutput } from "@/server/intelligence/node";
import { type SimStep, WOULD_SEND_TEXT } from "@/server/simulation/run";
import { SPEC_BY_TYPE, type WorkflowGraph } from "@/server/workflow/dsl/nodes";

const VERDICT: Record<string, { label: string; cls: string; icon: ReactNode }> = {
  WOULD_ALLOW: { label: "Would allow", cls: "bg-marker text-on-marker", icon: <Send size={18} aria-hidden /> },
  WOULD_REVIEW: { label: "Would require review", cls: "border-2 border-warn text-warn", icon: <CircleAlert size={18} aria-hidden /> },
  WOULD_DENY: { label: "Would deny", cls: "border-2 border-danger text-danger", icon: <CircleX size={18} aria-hidden /> },
  WOULD_END: { label: "Would end without PayPal", cls: "border-2 border-ink text-ink", icon: <CircleCheck size={18} aria-hidden /> },
  WOULD_WAIT: { label: "Would wait", cls: "border-2 border-ink text-ink", icon: <Hourglass size={18} aria-hidden /> },
  WOULD_SUSPEND: { label: "Would be suspended", cls: "border-2 border-warn text-warn", icon: <CircleAlert size={18} aria-hidden /> },
  ERROR: { label: "Could not evaluate", cls: "border-2 border-danger text-danger", icon: <CircleX size={18} aria-hidden /> },
};

/** What each node did, in one word or two. */
function resultOf(s: SimStep, wouldNode: string | null, approvals: { nodeId: string; status: string; assumed: boolean }[], isTest: boolean): { text: string; tone: "pass" | "warn" | "bad" | "info" | "would" } {
  const spec = SPEC_BY_TYPE[s.nodeType];
  const o = s.output as (AINodeOutput & { endNote?: string }) | null;
  const ap = approvals.find((a) => a.nodeId === s.nodeId);
  if (s.nodeId === wouldNode) return { text: "Would send — not contacted", tone: "would" };
  if (spec?.category === "trigger") return { text: isTest ? "Test input" : "Real PayPal event", tone: "info" };
  if (ap?.assumed) return { text: `Assumed ${ap.status.toLowerCase()}`, tone: "info" };
  if (s.status === "WAITING") return { text: spec?.movesMoney || spec?.external ? "Would ask a person" : "Would wait", tone: "warn" };
  if (s.status === "ERROR") {
    const code = (s.error as { code?: string } | null)?.code;
    return { text: code === "AUTHORITY_DENIED" ? "Would deny" : "Error", tone: "bad" };
  }
  if (spec?.isPolicy) return s.port === "pass" ? { text: "Pass", tone: "pass" } : { text: "Block", tone: "bad" };
  if (spec?.isAI && o) {
    const v = o.classification ?? o.verdict ?? o.level ?? "done";
    const bad = ["OUTSIDE_SCOPE", "MISMATCH", "HIGH"].includes(v);
    const warn = ["UNCERTAIN", "ELEVATED"].includes(v) || o.injection?.detected;
    return { text: v.replaceAll("_", " "), tone: bad ? "bad" : warn ? "warn" : "pass" };
  }
  if (s.nodeType === "control.approval") return { text: s.port ?? "", tone: s.port === "approved" ? "pass" : "bad" };
  if (s.nodeType === "control.terminal") return { text: "End", tone: "info" };
  return { text: s.port ?? "done", tone: "pass" };
}

const toneCls = { pass: "text-marker-ink", warn: "text-warn", bad: "text-danger", info: "text-muted", would: "text-ink font-semibold" };

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border-t-2 border-ink pt-3">
      <div className="pf-label">{label}</div>
      <div className="mt-1 text-headline font-semibold tracking-[-0.02em]">{value}</div>
      <div className="text-meta text-muted">{sub}</div>
    </div>
  );
}

const LABEL_TEXT: Record<string, string> = {
  REAL_OPENAI: "Real OpenAI",
  CACHED_AI_ANALYSIS: "Cached AI analysis",
  MOCK_TEST: "Mock AI (test)",
  CALCULATED_BY_PAYFLOW: "Calculated by PayFlow",
  AI_UNAVAILABLE: "AI unavailable",
};

export default async function SimulationPage(props: PageProps<"/simulations/[id]">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getSimulation(user.workspaceId, id);
  if (!data) notFound();
  const { s, workflowName, analyses } = data;
  const graph = s.graph as WorkflowGraph;
  const steps = s.steps as SimStep[];
  const approvals = s.approvals as { nodeId: string; reason: string; status: string; assumed: boolean }[];
  const would = s.wouldAction as { kind: string; nodeId: string; amount: { value: string; currency: string } | null; counterparty: string | null } | null;
  const v = VERDICT[s.verdict] ?? VERDICT.ERROR;
  const isTest = s.mode === "TEST";
  // A step decided by an assumption: no person decided anything.
  const assumedText = (nodeId: string) => {
    const a = (s.approvals as { nodeId: string; status: string; assumed: boolean }[]).find((x) => x.nodeId === nodeId && x.assumed);
    return a ? `Assumed ${a.status.toLowerCase()} inside this test — no person decided and no approval exists${a.status === "REJECTED" ? "; PayPal would not be contacted" : ""}` : null;
  };
  // Said from the record's own provenance, never from the engine's generic trigger text.
  const agentTest = (s.trigger as { kind?: string; payload?: { agent?: { name?: string } } }).kind === "agent_request";
  const triggerText = isTest
    ? agentTest
      ? `TEST request from AI agent “${(s.trigger as { payload: { agent?: { name?: string } } }).payload.agent?.name ?? "unknown"}” — evaluated in isolation; it can never become a live request`
      : "Test input provided by a person — not a PayPal event"
    : `Real PayPal event ${s.paypalEventId ?? ""} (confirmed with PayPal), evaluated in Observe Mode`;
  const pending = approvals.find((a) => a.status === "PENDING");
  const decision = s.authorityDecision as { request: { kind: string; amount: { value: string; currency: string } | null; counterparty: string | null; target: { type: string; id: string } | null }; outcome: AuthorityOutcome; evaluations: Evaluation[]; budget: BudgetSnapshot[]; frequency: FrequencySnapshot[]; authoritySnapshot: { id: string; name: string; version: number; perTransactionMax?: string | null }[]; decision?: string } | null;
  const overlay = Object.fromEntries(
    steps.map((st) => [st.nodeId, { state: st.nodeId === would?.nodeId ? ("current" as const) : st.status === "ERROR" ? ("error" as const) : st.status === "WAITING" ? ("waiting" as const) : ("ok" as const), port: st.port }]),
  );
  const outputs = steps.filter((st) => SPEC_BY_TYPE[st.nodeType]?.isAI && st.output && st.status === "OK").map((st) => st.output as AINodeOutput);
  const ai = s.ai as { task: string; label: string; model: string | null }[];
  const trigger = s.trigger as { kind: string; payload: Record<string, unknown> };

  return (
    <>
      <Link href={`/flows/${s.workflowId}`} className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> {workflowName}
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-2" role="status">
        <span className="inline-flex items-center gap-1.5 bg-ink px-2.5 py-1 text-label font-semibold uppercase tracking-[0.08em] text-surface">
          {isTest ? <FlaskConical size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
          {isTest ? "Test run" : "Observed real event"} — no money moved — PayPal not contacted
        </span>
        <span className="rounded-sm border border-line-strong px-1.5 py-px text-label font-semibold uppercase tracking-[0.06em] text-muted">{s.inputProvenance}</span>
        <span className="font-mono text-meta text-muted">
          {workflowName} v{s.versionNumber} · {s.mode === "OBSERVE" && s.paypalEventId ? `event ${s.paypalEventId} · ` : ""}
          {formatDay(s.evaluatedAt)} {formatClock(s.evaluatedAt)}
        </span>
      </div>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div>
          <span className={`inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-title font-semibold uppercase tracking-[0.04em] ${v.cls}`}>
            {v.icon}
            {v.label}
          </span>
          <p className="mt-3 max-w-2xl text-lead text-ink">{s.headline}</p>
          {isTest && pending && (
            <div className="mt-4">
              <AssumeButtons simulationId={s.id} nodeId={pending.nodeId} />
            </div>
          )}
          {s.parentId && (
            <p className="mt-2 text-body-sm text-muted">
              Explored from{" "}
              <Link href={`/simulations/${s.parentId}`} className="underline">
                the original test
              </Link>{" "}
              with {Object.entries(s.assumptions as Record<string, string>).map(([n, a]) => `“${graph.nodes.find((x) => x.id === n)?.label ?? n}” assumed ${a.toLowerCase()}`).join(", ")}.
            </p>
          )}
        </div>
        <div className="grid min-w-[420px] grid-cols-3 gap-6">
          <Tile label="PayPal" value="Not contacted" sub={would ? `would have sent ${would.kind.replace("paypal.", "")}` : "no action reached"} />
          <Tile label="Money moved" value="$0" sub={would?.amount ? `would have been ${money(would.amount.value, would.amount.currency)}` : "nothing to move"} />
          <Tile label="Real budget reserved" value="$0" sub="evaluated, never reserved" />
        </div>
      </header>

      {decision && (
        <div className="mt-8">
          <div className="pf-label mb-2">Why — the authority engine&rsquo;s checks</div>
          <DecisionChecks
            evaluations={decision.evaluations}
            decision={decision.decision ?? (decision.outcome === "DENY" ? "DENY" : decision.outcome === "ALLOW" ? "ALLOW" : "REVIEW")}
            amount={decision.request.amount}
            limits={(decision.authoritySnapshot ?? []).map((a) => a.perTransactionMax ?? null)}
            agent={(s.trigger as { kind?: string; payload?: { agent?: { name: string } } }).kind === "agent_request" ? ((s.trigger as { payload: { agent?: { name: string } } }).payload.agent ?? null) : null}
            humanDecision={approvals.find((a) => a.assumed)?.status ?? null}
          />
        </div>
      )}

      <div className="mt-10 grid gap-x-12 gap-y-10 xl:grid-cols-[1.25fr_1fr] [&>*]:min-w-0">
        <Section label="Path through the flow">
          <div className="mt-3 h-[560px] rounded border border-line bg-canvas">
            <RunGraph graph={graph} overlay={overlay} />
          </div>
        </Section>
        <Section label="What each step did" aside={`${steps.length} steps`}>
          <ol className="mt-2">
            {steps.map((st) => {
              const r = resultOf(st, would?.nodeId ?? null, approvals, isTest);
              return (
                <li key={st.nodeId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-line py-2.5">
                  <div className="min-w-0">
                    <div className="pf-label text-ink">{st.label}</div>
                    <div className="mt-0.5 text-body-sm text-ink-2">{SPEC_BY_TYPE[st.nodeType]?.category === "trigger" ? triggerText : st.nodeId === would?.nodeId ? WOULD_SEND_TEXT : (assumedText(st.nodeId) ?? st.explanation)}</div>
                  </div>
                  <div className={`text-right text-label font-semibold uppercase tracking-[0.06em] ${toneCls[r.tone]}`}>{r.text}</div>
                </li>
              );
            })}
          </ol>
        </Section>
      </div>

      {decision && (
        <Section label="Authority — evaluated against a snapshot" className="mt-10">
          <div className="mt-4 max-w-2xl">
            <DecisionTrace
              t={{
                request: { kind: decision.request.kind, amount: decision.request.amount, counterparty: decision.request.counterparty, target: decision.request.target },
                authorities: (decision.authoritySnapshot ?? []).map((a) => ({ id: a.id, name: a.name, version: a.version })),
                evaluations: decision.evaluations,
                budget: decision.budget ?? [],
                frequency: decision.frequency ?? [],
                outcome: decision.outcome,
                human: approvals.some((a) => a.assumed) ? { decision: approvals.find((a) => a.assumed)!.status as "APPROVED" | "REJECTED", note: "assumed in this test — not a real approval" } : pending ? { decision: "PENDING" } : null,
                paypal: { contacted: false },
              }}
            />
          </div>
        </Section>
      )}

      {outputs.length > 0 && (
        <div className="mt-10">
          <div className="mb-2 flex flex-wrap gap-2">
            {ai.map((a, i) => (
              <span key={i} className="rounded-sm border border-line-strong px-1.5 py-px text-label font-semibold uppercase tracking-[0.06em] text-ink-2">
                {a.task} · {LABEL_TEXT[a.label] ?? a.label}
              </span>
            ))}
          </div>
          <IntelligencePanel outputs={outputs} analyses={analyses} decision={decision ? { evaluations: decision.evaluations, outcome: decision.outcome } : null} />
        </div>
      )}

      <div className="mt-10 grid gap-x-12 gap-y-8 lg:grid-cols-2 [&>*]:min-w-0">
        <Section label={isTest ? "Test input — user provided" : "Real PayPal event observed"}>
          <pre className="mt-3 max-h-72 overflow-auto rounded-sm bg-sunken p-3 font-mono text-meta text-ink-2">{JSON.stringify(trigger.payload, null, 2)}</pre>
        </Section>
        <Section label="What this result means">
          <p className="mt-3 text-body text-ink-2">
            This describes how {workflowName} v{s.versionNumber} evaluated this {isTest ? "input" : "event"} with the authority, budget and AI evidence available at {formatClock(s.evaluatedAt)} on {formatDay(s.evaluatedAt)}. It is not a promise about future live runs: they can differ if the transaction, authority, budgets, workflow version, AI analysis or PayPal state change.
          </p>
          <p className="mt-2 text-body-sm text-muted">
            Authority versions: {(s.authorities as { name: string; version: number }[]).map((a) => `${a.name} v${a.version}`).join(", ") || "none"} · External actions were disabled for this {isTest ? "test" : "observation"}.
          </p>
        </Section>
      </div>
    </>
  );
}
