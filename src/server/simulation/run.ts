import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { canonicalJson } from "../audit/canonical-json";
import { scopeKeyFor } from "../authority/internal";
import { usageFor } from "../authority/ledger";
import { periodWindow } from "../authority/periods";
import { db } from "../db/client";
import { actionExecutions, aiAnalyses, approvals, authorities, authorityDecisions, paypalEvents, runSteps, simulations, workflowRuns, workflowVersions, workflows } from "../db/schema";
import { sha256 } from "../intelligence/framing";
import type { AINodeOutput } from "../intelligence/node";
import { ensureAnalysis, runAnalysis } from "../intelligence/runner";
import type { AnalysisInput, TaskName } from "../intelligence/tasks";
import { withSandbox, type SandboxMode } from "../runtime/mode";
import { evaluate, type Expr } from "../workflow/dsl/expression";
import { SPEC_BY_TYPE, type WorkflowGraph } from "../workflow/dsl/nodes";
import { validateGraph } from "../workflow/dsl/validate";
import { advanceRun } from "../workflow/runtime/engine";
import { normalizePayPalEvent } from "../workflow/runtime/trigger";
import type { RuntimeDeps } from "../workflow/runtime/types";

/**
 * Test Run and Observe Mode.
 *
 * The REAL engine — graph interpreter, policy gates, budget and frequency
 * nodes, the authority engine, Phase-7 intelligence, approval routing — runs
 * inside one database transaction that is always rolled back, under a sandbox
 * execution context. Its action port records "would send" instead of sending;
 * the PayPal write capability cannot be obtained in that context and the PayPal
 * clients refuse writes there. Every reservation, decision, approval, ledger
 * row and audit line the engine writes is discarded with the transaction.
 *
 * What persists is a `simulations` record: the exact graph and authority
 * versions evaluated, the input and its provenance, the path, the verdict.
 * AI analyses needed by a pass are computed outside the sandbox (they are
 * evidence, not side effects) through the normal cached, metered runner, and
 * the pass is replayed from the start.
 */

export type Verdict = "WOULD_ALLOW" | "WOULD_REVIEW" | "WOULD_DENY" | "WOULD_END" | "WOULD_WAIT" | "WOULD_SUSPEND" | "ERROR";
export type Assumption = "APPROVED" | "REJECTED";

export type SimulationRequest = {
  mode: SandboxMode;
  workspaceId: string;
  workflowId: string;
  /** Default: the latest version (the draft, if there is one). */
  versionId?: string;
  trigger: { kind: "manual" | "paypal_event"; payload: Record<string, unknown>; paypalEventId?: string };
  assumptions?: Record<string, Assumption>;
  userId?: string | null;
  parentId?: string | null;
};

export type SimStep = { nodeId: string; nodeType: string; label: string; status: string; port: string | null; explanation: string; output: unknown; error?: unknown };

type Captured = {
  needsAnalysis: { task: TaskName; input: AnalysisInput } | null;
  runStatus: string;
  outcome: string | null;
  steps: SimStep[];
  wouldAction: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  approvals: { nodeId: string; reason: string; status: string; assumed: boolean }[];
  ai: { task: string; analysisId: string | null; provider: string | null; model: string | null; cached: boolean; source: string; status: string }[];
};

class Rollback extends Error {
  constructor(readonly captured: Captured) {
    super("sandbox rollback");
  }
}

const MAX_PASSES = 8;

/** Fails before any engine code runs if the graph cannot be activated (draft-only nodes, invalid wiring). */
function check(graph: WorkflowGraph) {
  const v = validateGraph(graph, { forActivation: true });
  const errors = v.issues.filter((i) => i.severity === "error");
  return errors.length ? errors.map((e) => e.message).join("; ") : null;
}

export async function simulate(req: SimulationRequest): Promise<{ ok: true; id: string; verdict: Verdict } | { ok: false; error: string }> {
  if (req.mode !== "TEST" && req.mode !== "OBSERVE") return { ok: false, error: "A simulation is TEST or OBSERVE, never LIVE" };
  const [wf] = await db().select().from(workflows).where(and(eq(workflows.id, req.workflowId), eq(workflows.workspaceId, req.workspaceId)));
  if (!wf) return { ok: false, error: "Workflow not found" };
  const [version] = req.versionId
    ? await db().select().from(workflowVersions).where(and(eq(workflowVersions.id, req.versionId), eq(workflowVersions.workflowId, wf.id)))
    : await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)).orderBy(desc(workflowVersions.version)).limit(1);
  if (!version) return { ok: false, error: "Version not found" };
  const graph = version.graph as WorkflowGraph;
  const problem = check(graph);
  if (problem) return { ok: false, error: `This version cannot run yet: ${problem}` };

  const id = randomUUID();
  const started = Date.now();
  const evaluatedAt = new Date();
  const performed = new Set<string>();
  const authorityRows = await db()
    .select({ id: authorities.id, name: authorities.name, version: authorities.version, status: authorities.status, budgetAmount: authorities.budgetAmount, budgetPeriod: authorities.budgetPeriod, currencies: authorities.currencies })
    .from(authorities)
    .where(and(eq(authorities.workspaceId, req.workspaceId), sql`${authorities.workflowIds} @> ${JSON.stringify([wf.id])}::jsonb`));
  // The budget state the evaluation reads, as a snapshot (read-only).
  const budget: { authorityId: string; name: string; limit: string; currency: string; period: string; committed: string; reserved: string }[] = [];
  for (const a of authorityRows) {
    if (!a.budgetAmount || !a.budgetPeriod) continue;
    const w = periodWindow(a.budgetPeriod, evaluatedAt);
    const u = await db().transaction((tx) => usageFor(tx, req.workspaceId, scopeKeyFor(a.id), w));
    budget.push({ authorityId: a.id, name: a.name, limit: a.budgetAmount, currency: a.currencies[0], period: w.label, committed: u.committed, reserved: u.reserved });
  }

  let captured: Captured | null = null;
  let error: string | null = null;
  try {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      captured = await withSandbox(req.mode, id, () => sandboxPass(req, wf.id, version.id, graph, evaluatedAt, id, pass));
      if (!captured.needsAnalysis) break;
      // Evidence, not a side effect: computed for real (cached, metered, with provenance), then the pass replays.
      const need = captured.needsAnalysis;
      const { row } = await db().transaction((tx) => ensureAnalysis(tx, { workspaceId: req.workspaceId, task: need.task, analysis: need.input, runId: id }));
      // Only an analysis computed now counts as fresh; one found already done is a cache hit.
      if (row.status === "PENDING") {
        await runAnalysis(row.id);
        performed.add(row.id);
      }
      if (pass === MAX_PASSES - 1) error = "Too many analyses needed for one simulation";
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // The replay pass reads analyses computed a moment ago as "cached"; say what really happened.
  if (captured) {
    for (const st of captured.steps) {
      const o = st.output as { analysisId?: string | null; cached?: boolean } | null;
      if (o?.analysisId && performed.has(o.analysisId) && o.cached) {
        o.cached = false;
        st.explanation = st.explanation.replace(" · reused from cache", " · computed for this test");
      }
    }
    for (const x of captured.ai) if (x.analysisId && performed.has(x.analysisId)) x.cached = false;
    // The engine's action text says "sending to PayPal"; in a sandbox the action port stopped it before contact.
    const would = (captured.wouldAction as { nodeId?: string } | null)?.nodeId;
    const st = would ? captured.steps.find((x) => x.nodeId === would) : undefined;
    if (st) st.explanation = WOULD_SEND_TEXT;
  }
  const c = captured;
  const verdict: Verdict = error || !c ? "ERROR" : verdictOf(c);
  const headline = error ? `Could not complete: ${error}` : headlineOf(c!, verdict);
  const aiLabels = (c?.ai ?? []).map((x) => ({
    ...x,
    // Unavailable first: an analysis the budget guard refused was attempted but never reached a model.
    label: x.source === "payflow" ? "CALCULATED_BY_PAYFLOW" : x.status === "UNAVAILABLE" ? "AI_UNAVAILABLE" : x.provider === "mock" ? "MOCK_TEST" : x.analysisId && performed.has(x.analysisId) ? (x.provider === "openai" ? "REAL_OPENAI" : `REAL_${(x.provider ?? "AI").toUpperCase()}`) : "CACHED_AI_ANALYSIS",
  }));
  const graphHash = sha256(canonicalJson({ nodes: graph.nodes, edges: graph.edges }));

  const inserted = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(simulations)
      .values({
        id,
        workspaceId: req.workspaceId,
        mode: req.mode,
        inputProvenance: req.mode === "TEST" ? "TEST_INPUT" : "REAL_PAYPAL_EVENT_OBSERVED",
        workflowId: wf.id,
        versionId: version.id,
        versionNumber: version.version,
        graph,
        graphHash,
        authorities: authorityRows.map((a) => ({ id: a.id, name: a.name, version: a.version, status: a.status })),
        paypalEventId: req.trigger.paypalEventId ?? null,
        trigger: req.trigger,
        assumptions: req.assumptions ?? {},
        parentId: req.parentId ?? null,
        steps: c?.steps ?? [],
        verdict,
        headline,
        wouldAction: c?.wouldAction ?? null,
        authorityDecision: c?.decision ?? null,
        approvals: c?.approvals ?? [],
        ai: aiLabels,
        budget,
        evaluatedAt,
        externalActionsDisabled: true,
        durationMs: Date.now() - started,
        error,
        createdBy: req.userId ?? null,
      })
      .onConflictDoNothing({ target: [simulations.workflowId, simulations.graphHash, simulations.paypalEventId] })
      .returning({ id: simulations.id });
    if (!row) return null; // this draft already observed this event
    await appendAudit(tx, {
      workspaceId: req.workspaceId,
      actor: req.userId ? `user:${req.userId}` : "system",
      kind: req.mode === "TEST" ? "simulation.test_run" : "simulation.observed",
      summary: `${req.mode === "TEST" ? "TEST RUN" : "OBSERVED REAL EVENT"} — no money moved, PayPal not contacted · “${wf.name}” v${version.version} · ${verdict.replaceAll("_", " ")}`,
      payload: { simulationId: id, inputProvenance: req.mode === "TEST" ? "TEST_INPUT" : "REAL_PAYPAL_EVENT_OBSERVED", verdict, versionId: version.id, graphHash, externalActionsDisabled: true, paypalEventId: req.trigger.paypalEventId ?? null },
      workflowId: wf.id,
    });
    return row;
  });
  if (!inserted) return { ok: false, error: "Already observed" };
  return { ok: true, id, verdict };
}

export const WOULD_SEND_TEXT = "Would send this to PayPal — stopped before any contact; nothing was sent";

/** One pass of the real engine inside a transaction that is always rolled back. */
async function sandboxPass(req: SimulationRequest, workflowId: string, versionId: string, graph: WorkflowGraph, evaluatedAt: Date, simId: string, pass: number): Promise<Captured> {
  try {
    await db().transaction(async (tx) => {
      const trigger = graph.nodes.find((n) => SPEC_BY_TYPE[n.type]?.category === "trigger")!;
      const runId = randomUUID();
      await tx.insert(workflowRuns).values({
        id: runId,
        workspaceId: req.workspaceId,
        workflowId,
        versionId,
        triggerKind: req.mode === "TEST" ? "test" : "observe",
        triggerRef: `sim:${simId}:${pass}`,
        triggerPayload: req.trigger.payload,
        provenance: req.mode === "TEST" ? "USER_PROVIDED" : "REAL_PAYPAL_SANDBOX",
        currentNodeId: trigger.id,
      });

      let needsAnalysis: Captured["needsAnalysis"] = null;
      let wouldExecute: string | null = null;
      const deps: RuntimeDeps = {
        enqueueAdvance: async () => {}, // nothing is ever scheduled from a sandbox
        now: () => evaluatedAt,
        transaction: (fn) => tx.transaction(fn),
        // The only action port a sandbox has: it records the action and stops. It holds no PayPal capability.
        actions: {
          execute: async (executionId) => {
            wouldExecute = executionId;
            return "simulated";
          },
        },
        analysis: {
          run: async (analysisId) => {
            const [row] = await tx.select().from(aiAnalyses).where(eq(aiAnalyses.id, analysisId));
            const r = row.request as AnalysisInput;
            needsAnalysis = { task: row.task as TaskName, input: { context: r.context, documents: r.documents } };
            return "stop";
          },
        },
      };

      const assumed = new Set<string>();
      for (let k = 0; k < 12; k++) {
        const status = await advanceRun(runId, deps);
        if (needsAnalysis || wouldExecute || status !== "WAITING_APPROVAL") break;
        const [pending] = await tx.select().from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.status, "PENDING")));
        const choice = pending && req.assumptions?.[pending.nodeId];
        if (!choice) break;
        // Exploration only: this "decision" lives and dies inside the rolled-back transaction.
        await tx.update(approvals).set({ status: choice, decidedAt: evaluatedAt, note: "Assumed in a test run" }).where(eq(approvals.id, pending.id));
        assumed.add(pending.nodeId);
      }

      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
      const [decision] = await tx.select().from(authorityDecisions).where(eq(authorityDecisions.runId, runId)).orderBy(desc(authorityDecisions.createdAt)).limit(1);
      const runApprovals = await tx.select().from(approvals).where(eq(approvals.runId, runId));
      const [ex] = wouldExecute ? await tx.select().from(actionExecutions).where(eq(actionExecutions.id, wouldExecute)) : [];
      const aiOutputs = steps.filter((s) => SPEC_BY_TYPE[s.nodeType]?.isAI && s.output && s.status === "OK").map((s) => s.output as AINodeOutput);
      const ids = aiOutputs.map((o) => o.analysisId).filter((x): x is string => !!x);
      const rows = ids.length ? await tx.select({ id: aiAnalyses.id, provider: aiAnalyses.provider, model: aiAnalyses.model }).from(aiAnalyses).where(inArray(aiAnalyses.id, ids)) : [];

      throw new Rollback({
        needsAnalysis,
        runStatus: run.status,
        outcome: run.outcome,
        steps: steps.map((s) => ({
          nodeId: s.nodeId,
          nodeType: s.nodeType,
          label: graph.nodes.find((n) => n.id === s.nodeId)?.label ?? SPEC_BY_TYPE[s.nodeType]?.title ?? s.nodeType,
          status: s.status,
          port: s.port,
          explanation: s.explanation ?? "",
          output: s.output,
          error: s.error ?? null,
        })),
        wouldAction: ex
          ? {
              kind: ex.kind,
              nodeId: ex.nodeId,
              amount: ex.amountValue ? { value: ex.amountValue, currency: ex.currency } : null,
              counterparty: ex.counterparty,
              target: ex.targetRef,
              authorityOutcome: (ex.intent as { authorization?: { authority?: { outcome?: string } } }).authorization?.authority?.outcome ?? null,
            }
          : null,
        decision: decision
          ? { request: decision.request, decision: decision.decision, outcome: decision.outcome, evaluations: decision.evaluations, budget: decision.budget, frequency: decision.frequency, authoritySnapshot: decision.authoritySnapshot, provider: decision.provider }
          : null,
        approvals: runApprovals.map((a) => ({ nodeId: a.nodeId, reason: a.reason, status: a.status, assumed: assumed.has(a.nodeId) })),
        ai: aiOutputs.map((o) => {
          const r = rows.find((x) => x.id === o.analysisId);
          return { task: o.task, analysisId: o.analysisId, provider: r?.provider ?? null, model: r?.model ?? o.model, cached: o.cached, source: o.source, status: o.status };
        }),
      });
    });
  } catch (e) {
    if (e instanceof Rollback) return e.captured;
    throw e;
  }
  throw new Error("sandbox transaction committed unexpectedly");
}

function verdictOf(c: Captured): Verdict {
  if (c.wouldAction) return "WOULD_ALLOW";
  switch (c.runStatus) {
    case "WAITING_APPROVAL":
    case "NEEDS_REVIEW":
      return "WOULD_REVIEW";
    case "BLOCKED":
      return "WOULD_DENY";
    case "WAITING_TIMER":
      return "WOULD_WAIT";
    case "SUSPENDED":
      return "WOULD_SUSPEND";
    case "COMPLETED":
    case "REJECTED":
      return "WOULD_END";
    default:
      return "ERROR";
  }
}

function headlineOf(c: Captured, v: Verdict): string {
  const a = c.wouldAction as { kind: string; amount: { value: string; currency: string } | null; counterparty: string | null; authorityOutcome: string | null } | null;
  if (v === "WOULD_ALLOW" && a) {
    const after = a.authorityOutcome === "ALLOW_AFTER_HUMAN_APPROVAL" || c.approvals.some((x) => x.assumed && x.status === "APPROVED") ? " after the assumed approval" : "";
    return `Would send ${a.kind.replace("paypal.", "")}${a.amount ? ` ${a.amount.value} ${a.amount.currency}` : ""}${a.counterparty ? ` → ${a.counterparty}` : ""} to PayPal${after} — not sent in this test`;
  }
  if (v === "WOULD_REVIEW") {
    const p = c.approvals.find((x) => x.status === "PENDING");
    return p ? `Would wait for a person: ${p.reason.replace(/^Authority review: /, "")}` : (c.outcome ?? "Would need review");
  }
  // The engine's own text says "rejected by a person"; in a test nobody decided anything.
  if (c.approvals.some((x) => x.assumed && x.status === "REJECTED")) return "After the assumed rejection (only inside this test) the run would end here; PayPal would not be contacted";
  return c.outcome ?? v;
}

/**
 * Observe Mode: a real, PayPal-confirmed event is evaluated by every observing
 * draft whose trigger matches. Runs after live routing, never instead of it.
 */
export async function observeEvent(paypalEventRowId: string) {
  const [ev] = await db().select().from(paypalEvents).where(eq(paypalEvents.id, paypalEventRowId));
  if (!ev || ev.provenance !== "REAL_PAYPAL_SANDBOX" || !ev.routedAt) return [];
  const trigger = normalizePayPalEvent(ev.raw as Parameters<typeof normalizePayPalEvent>[0]);
  const watchers = await db().select().from(workflows).where(and(eq(workflows.workspaceId, ev.workspaceId), eq(workflows.observing, true)));
  const results = [];
  for (const wf of watchers) {
    const [latest] = await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)).orderBy(desc(workflowVersions.version)).limit(1);
    const t = (latest.graph as WorkflowGraph).nodes.find((n) => n.type === "trigger.paypal_event");
    const types = (t?.config as { eventTypes?: string[] } | undefined)?.eventTypes ?? [];
    if (!t || !types.includes(ev.eventType)) continue;
    const filter = (t.config as { filter?: Expr }).filter;
    if (filter) {
      try {
        if (!evaluate(filter, { trigger })) continue;
      } catch {
        continue;
      }
    }
    results.push(
      await simulate({
        mode: "OBSERVE",
        workspaceId: ev.workspaceId,
        workflowId: wf.id,
        versionId: latest.id,
        trigger: { kind: "paypal_event", payload: trigger as unknown as Record<string, unknown>, paypalEventId: ev.eventId },
      }),
    );
  }
  return results;
}
