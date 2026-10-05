import { asc, desc, eq } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { actionExecutions, agentRequests, approvals, authorityDecisions, runSteps, simulations, workflowRuns } from "../db/schema";
import { NOT_SENT_CODES } from "./binding";
import { appendLinks } from "./receipt";

/**
 * The agent-facing state of a request, derived from the real engine rows (run,
 * authority decision, approval, PayPal execution). Accepting a request is
 * never reported as payment: COMPLETED means PayPal accepted the action.
 */
export type AgentState =
  | "ACCEPTED"
  | "PROCESSING"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "REJECTED"
  | "DENIED"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN"
  | "ENDED"
  | "TEST_COMPLETE";

export const TERMINAL: AgentState[] = ["REJECTED", "DENIED", "CANCELLED", "COMPLETED", "FAILED", "UNKNOWN", "ENDED", "TEST_COMPLETE"];

export const STATE_MEANING: Record<AgentState, string> = {
  ACCEPTED: "PayFlow accepted the request into the workflow. Nothing has been decided or paid.",
  PROCESSING: "The workflow is evaluating or carrying out the request. Not paid yet.",
  REVIEW_REQUIRED: "A person must decide. The agent cannot approve it. PayPal has not been contacted.",
  APPROVED: "A person approved it once; PayFlow is about to carry it out. Not paid yet.",
  REJECTED: "A person rejected it, or the review expired. PayPal was not contacted.",
  DENIED: "PayFlow's authority refused it. PayPal was not contacted.",
  CANCELLED: "Withdrawn (by the agent, or because the agent was revoked) before PayPal was contacted.",
  COMPLETED: "PayPal accepted the action. See paypal.status for its PayPal state.",
  FAILED: "PayPal refused the action. Nothing was paid.",
  UNKNOWN: "PayPal gave no definitive answer; held for a person to reconcile. Do not retry with a new request_id.",
  ENDED: "The workflow ended without a payment action.",
  TEST_COMPLETE: "TEST only: evaluated in isolation. No money moved and PayPal was not contacted.",
};

/** Machine-readable reasons from the authority engine's non-passing checks. */
const CHECK_CODE: Record<string, (result: string) => string> = {
  per_transaction: () => "AMOUNT_OVER_TRANSACTION_LIMIT",
  budget: () => "BUDGET_EXCEEDED",
  frequency: () => "FREQUENCY_LIMIT_REACHED",
  counterparty: (r) => (r === "deny" ? "COUNTERPARTY_DENIED" : "COUNTERPARTY_NOT_APPROVED"),
  currency: () => "CURRENCY_NOT_ALLOWED",
  action: () => "ACTION_NOT_IN_AUTHORITY",
  purpose: () => "PURPOSE_NOT_WITHIN_SCOPE",
  risk: () => "RISK_ELEVATED",
  contract: () => "CONTRACT_MISMATCH",
  injection: () => "INSTRUCTIONS_IN_UNTRUSTED_TEXT",
  extraction: () => "EVIDENCE_CONFLICT",
  authority: () => "NO_COVERING_AUTHORITY",
  status: () => "AUTHORITY_NOT_ACTIVE",
  validity: () => "AUTHORITY_NOT_VALID_NOW",
  state: () => "AI_EVIDENCE_UNAVAILABLE",
};

type Evaluation = { check: string; result: string; detail: string; source?: string };

export type StatusView = {
  reference: string;
  request_id: string;
  mode: "LIVE" | "TEST";
  state: AgentState;
  meaning: string;
  terminal: boolean;
  reasons: { code: string; detail: string; source: "payflow" | "ai" }[];
  authority: { decision: string; outcome: string | null; authorities: { id: string; name: string; version: number }[] } | null;
  human_review: { required: boolean; status: string | null; decided_at: string | null } | null;
  paypal: { contacted: boolean; money_moved: boolean; status: string | null; ids: string[]; confirmed_by_webhook: boolean };
  test: { verdict: string; headline: string; paypal_contacted: false } | null;
  receipt: { id: string; hash: string; links: number };
};

async function facts(handle: Tx | ReturnType<typeof db>, ar: typeof agentRequests.$inferSelect) {
  if (!ar.runId) return null;
  const [run] = await handle.select().from(workflowRuns).where(eq(workflowRuns.id, ar.runId));
  const exs = await handle.select().from(actionExecutions).where(eq(actionExecutions.runId, ar.runId)).orderBy(asc(actionExecutions.preparedAt));
  const ex = exs.find((x) => x.kind === (ar.envelope as { action: string }).action) ?? exs[0] ?? null;
  const aps = await handle.select().from(approvals).where(eq(approvals.runId, ar.runId)).orderBy(asc(approvals.requestedAt));
  const decs = await handle.select().from(authorityDecisions).where(eq(authorityDecisions.runId, ar.runId)).orderBy(asc(authorityDecisions.createdAt));
  const [step] = await handle.select({ id: runSteps.id }).from(runSteps).where(eq(runSteps.runId, ar.runId)).limit(1);
  return { run, ex, aps, decs, started: !!step };
}

export async function deriveState(handle: Tx | ReturnType<typeof db>, ar: typeof agentRequests.$inferSelect): Promise<{ state: AgentState; reasons: StatusView["reasons"]; f: Awaited<ReturnType<typeof facts>> }> {
  if (ar.mode === "TEST") return { state: ar.simulationId ? "TEST_COMPLETE" : "PROCESSING", reasons: [], f: null };
  const f = await facts(handle, ar);
  const reasons: StatusView["reasons"] = [];
  const dec = f?.decs.at(-1);
  for (const e of (dec?.evaluations as Evaluation[] | undefined) ?? []) {
    if (e.result === "pass") continue;
    reasons.push({ code: (CHECK_CODE[e.check] ?? (() => `${e.check.toUpperCase()}_${e.result.toUpperCase()}`))(e.result), detail: e.detail, source: e.source === "ai" ? "ai" : "payflow" });
  }
  // Withdrawn (by the agent or by its revocation) — unless the run itself was blocked, which says more precisely why.
  if (ar.state === "CANCELLED" && f?.run?.status !== "BLOCKED") {
    return { state: "CANCELLED", reasons: [{ code: "WITHDRAWN", detail: "Withdrawn before PayPal was contacted", source: "payflow" }, ...reasons], f };
  }
  if (!f?.run) return { state: "ACCEPTED", reasons, f };
  const { run, ex, aps } = f;
  const ap = aps.at(-1);
  if (ex) {
    const err = ex.error as { code?: string; message?: string } | null;
    if (ex.status === "SUCCEEDED") return { state: "COMPLETED", reasons, f };
    if (ex.status === "UNKNOWN") return { state: "UNKNOWN", reasons: [...reasons, { code: err?.code ?? "OUTCOME_UNKNOWN", detail: err?.message ?? "No definitive answer from PayPal", source: "payflow" }], f };
    if (ex.status === "FAILED") {
      const code = err?.code ?? "PAYPAL_REFUSED";
      const r = [...reasons, { code, detail: err?.message ?? "", source: "payflow" as const }];
      if (code === "AGENT_REVOKED" || code === "AGENT_EXPIRED" || code === "AGENT_REQUEST_CANCELLED") return { state: "CANCELLED", reasons: r, f };
      return { state: NOT_SENT_CODES.has(code) ? "DENIED" : "FAILED", reasons: r, f };
    }
    if (ex.attempts === 0 && ap?.status === "APPROVED") return { state: "APPROVED", reasons, f };
    return { state: "PROCESSING", reasons, f };
  }
  if (run.status === "BLOCKED") {
    // The step that blocked the run says why first (e.g. AGENT_REVOKED, INTENT_MISMATCH, an authority DENY).
    const blocked = await handle.select({ error: runSteps.error }).from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(desc(runSteps.seq));
    const e = blocked.map((b) => b.error as { code?: string; message?: string } | null).find((x) => x?.code);
    const lead = e?.code && e.code !== "AUTHORITY_DENIED" ? [{ code: e.code, detail: e.message ?? "", source: "payflow" as const }] : [];
    const cancelled = e?.code === "AGENT_REVOKED" || e?.code === "AGENT_EXPIRED" || e?.code === "AGENT_REQUEST_CANCELLED";
    return { state: cancelled ? "CANCELLED" : "DENIED", reasons: [...lead, ...reasons], f };
  }
  if (ap?.status === "PENDING") return { state: "REVIEW_REQUIRED", reasons, f };
  if (ap?.status === "REJECTED" && !ap.decidedBy && ap.note?.startsWith("Withdrawn")) {
    return { state: "CANCELLED", reasons: [...reasons, { code: ap.note.includes("revoked") ? "AGENT_REVOKED" : "WITHDRAWN_BY_AGENT", detail: ap.note, source: "payflow" }], f };
  }
  if (ap?.status === "REJECTED" || ap?.status === "EXPIRED") {
    return { state: "REJECTED", reasons: [...reasons, { code: ap.status === "EXPIRED" ? "REVIEW_EXPIRED" : "REJECTED_BY_PERSON", detail: ap.note ?? "", source: "payflow" }], f };
  }
  if (ap?.status === "APPROVED" && !["BLOCKED", "FAILED", "REJECTED"].includes(run.status)) return { state: "APPROVED", reasons, f };
  switch (run.status) {
    case "REJECTED":
      return { state: "REJECTED", reasons, f };
    case "FAILED":
      return { state: "FAILED", reasons: [...reasons, { code: "WORKFLOW_FAILED", detail: run.outcome ?? "", source: "payflow" }], f };
    case "COMPLETED":
    case "NEEDS_REVIEW":
      return { state: "ENDED", reasons: [...reasons, { code: "NO_PAYMENT_ACTION", detail: run.outcome ?? "", source: "payflow" }], f };
    case "WAITING_APPROVAL":
      return { state: "REVIEW_REQUIRED", reasons, f };
    default:
      return { state: f.started ? "PROCESSING" : "ACCEPTED", reasons, f };
  }
}

/**
 * Brings a request's stored state and receipt chain up to date with what the
 * engine and PayPal actually did. Idempotent; safe to call from anywhere.
 */
export async function syncAgentRequest(id: string): Promise<typeof agentRequests.$inferSelect | null> {
  return db().transaction(async (tx) => {
    const [ar] = await tx.select().from(agentRequests).where(eq(agentRequests.id, id)).for("update");
    if (!ar) return null;
    const { state, reasons, f } = await deriveState(tx, ar);
    const add: Parameters<typeof appendLinks>[2] = [];
    if (ar.mode === "TEST" && ar.simulationId) {
      const [sim] = await tx.select().from(simulations).where(eq(simulations.id, ar.simulationId));
      if (sim) add.push({ kind: "test_result", key: `test:${sim.id}`, at: sim.createdAt, data: { simulation_id: sim.id, verdict: sim.verdict, headline: sim.headline, paypal_contacted: false, money_moved: false } });
    }
    for (const d of f?.decs ?? []) {
      add.push({
        kind: "authority_decision",
        key: `decision:${d.id}`,
        at: d.createdAt,
        data: {
          decision_id: d.id,
          decision: d.decision,
          outcome: d.outcome,
          authorities: ((d.authoritySnapshot as { id: string; name: string; version: number }[] | null) ?? []).map((a) => ({ id: a.id, name: a.name, version: a.version })),
          reasons: reasons.filter((r) => r.code !== "WITHDRAWN").map((r) => r.code),
        },
      });
    }
    for (const a of f?.aps ?? []) {
      add.push({ kind: "human_review_required", key: `review:${a.id}`, at: a.requestedAt, data: { approval_id: a.id, reason: a.reason } });
      if (a.status !== "PENDING" && a.decidedAt) {
        add.push({
          kind: "human_review_decided",
          key: `decided:${a.id}`,
          at: a.decidedAt,
          data: { approval_id: a.id, status: a.status, decided_by: a.decidedBy ? `user:${a.decidedBy}` : a.note?.startsWith("Withdrawn") ? "withdrawn" : "system" },
        });
      }
    }
    const ex = f?.ex;
    if (ex && ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(ex.status)) {
      add.push({
        kind: "paypal_result",
        key: `paypal:${ex.id}:${ex.status}`,
        at: ex.completedAt ?? new Date(),
        data: {
          execution_id: ex.id,
          status: ex.status,
          contacted: ex.attempts > 0,
          paypal_ids: ex.paypalRefs,
          paypal_status: ex.paypalStatus,
          debug_id: ex.debugId,
          error_code: (ex.error as { code?: string } | null)?.code ?? null,
          amount: ex.amountValue ? { value: ex.amountValue, currency: ex.currency } : null,
          counterparty: ex.counterparty,
          target: ex.targetRef,
        },
      });
    }
    // Keyed by state: if a later sync corrects the final state, the correction is appended, never rewritten.
    if (ex?.confirmedByEventId) {
      add.push({ kind: "paypal_confirmed", key: `confirmed:${ex.id}`, at: ex.confirmedAt ?? new Date(), data: { execution_id: ex.id, paypal_event_id: ex.confirmedByEventId, paypal_ids: ex.paypalRefs, note: "PayPal's own event (verified with PayPal's API) confirmed this action" } });
    }
    const lastFinal = (ar.links as { kind: string; data: { state?: string } }[]).filter((l) => l.kind === "final").at(-1)?.data.state;
    if (TERMINAL.includes(state) && lastFinal !== state) add.push({ kind: "final", key: `final:${state}`, at: new Date(), data: { state } });
    await appendLinks(tx, ar, add);
    if (state !== ar.state) await tx.update(agentRequests).set({ state, updatedAt: new Date() }).where(eq(agentRequests.id, ar.id));
    const [fresh] = await tx.select().from(agentRequests).where(eq(agentRequests.id, ar.id));
    return fresh;
  });
}

/** Called after the engine advances any run: keeps the agent's view and the receipt chain current. */
export async function syncAgentRequestForRun(runId: string) {
  const [ar] = await db().select({ id: agentRequests.id }).from(agentRequests).where(eq(agentRequests.runId, runId));
  if (ar) await syncAgentRequest(ar.id);
}

export async function statusView(ar: typeof agentRequests.$inferSelect): Promise<StatusView> {
  const { state, reasons, f } = await deriveState(db(), ar);
  const dec = f?.decs.at(-1);
  const ap = f?.aps.at(-1);
  const ex = f?.ex;
  let test: StatusView["test"] = null;
  if (ar.mode === "TEST" && ar.simulationId) {
    const [sim] = await db().select({ verdict: simulations.verdict, headline: simulations.headline }).from(simulations).where(eq(simulations.id, ar.simulationId));
    if (sim) test = { verdict: sim.verdict, headline: sim.headline, paypal_contacted: false };
  }
  return {
    reference: ar.reference,
    request_id: ar.requestId,
    mode: ar.mode,
    state,
    meaning: STATE_MEANING[state],
    terminal: TERMINAL.includes(state),
    reasons,
    authority: dec
      ? { decision: dec.decision, outcome: dec.outcome, authorities: ((dec.authoritySnapshot as { id: string; name: string; version: number }[] | null) ?? []).map((a) => ({ id: a.id, name: a.name, version: a.version })) }
      : null,
    human_review: ap ? { required: true, status: ap.status, decided_at: ap.decidedAt?.toISOString() ?? null } : f ? { required: false, status: null, decided_at: null } : null,
    paypal: {
      contacted: !!ex && ex.attempts > 0,
      money_moved: !!ex && ex.status === "SUCCEEDED" && ex.amountValue != null,
      status: ex?.paypalStatus ?? null,
      ids: ex?.paypalRefs ?? [],
      confirmed_by_webhook: !!ex?.confirmedByEventId,
    },
    test,
    receipt: { id: ar.reference, hash: ar.receiptHash, links: (ar.links as unknown[]).length },
  };
}
