import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { agentRequests, agents, workflowRuns } from "../db/schema";
import type { ActionIntent } from "../actions/types";
import { normalizeMoney } from "./envelope";
import { verifyReceipt, type IntentReceipt } from "./receipt";

/**
 * Binds a run started by an agent to that agent's Intent Receipt.
 *
 * Checked twice: when the action is prepared (before the authority decision)
 * and again immediately before PayPal is contacted. Any money-moving action in
 * an agent-started run must be exactly what the agent asked for — same kind,
 * same amount and currency, same recipient — the receipt must be intact, and
 * the agent must still be active. Otherwise nothing is sent.
 */
export type BindingResult = { ok: true } | { ok: false; code: BindingCode; message: string };
export type BindingCode = "AGENT_REQUEST_MISSING" | "RECEIPT_TAMPERED" | "AGENT_REVOKED" | "AGENT_EXPIRED" | "AGENT_REQUEST_CANCELLED" | "INTENT_MISMATCH";

/** Execution errors that mean "stopped before PayPal was contacted". */
export const NOT_SENT_CODES = new Set<string>(["AUTHORITY_WITHDRAWN", "AGENT_REQUEST_MISSING", "RECEIPT_TAMPERED", "AGENT_REVOKED", "AGENT_EXPIRED", "AGENT_REQUEST_CANCELLED", "INTENT_MISMATCH"]);

const bound = (i: Pick<ActionIntent, "kind" | "movesMoney">) => i.movesMoney || i.kind === "paypal.invoice_send";

export async function checkAgentBinding(handle: DbOrTx, runId: string, intent: Pick<ActionIntent, "kind" | "movesMoney" | "amount" | "counterparty" | "target">, now = new Date()): Promise<BindingResult> {
  const [run] = await handle.select({ triggerKind: workflowRuns.triggerKind }).from(workflowRuns).where(eq(workflowRuns.id, runId));
  const [ar] = await handle.select().from(agentRequests).where(eq(agentRequests.runId, runId));
  if (!ar) {
    return run?.triggerKind === "agent_request" ? { ok: false, code: "AGENT_REQUEST_MISSING", message: "This run says an agent started it, but there is no agent request on record" } : { ok: true };
  }
  const v = await verifyReceipt(handle, ar);
  if (!v.ok) return { ok: false, code: "RECEIPT_TAMPERED", message: `Intent receipt ${ar.reference} failed verification: ${v.problems[0]}` };
  const [agent] = await handle.select({ status: agents.status, expiresAt: agents.expiresAt, name: agents.name }).from(agents).where(eq(agents.id, ar.agentId));
  if (!agent || agent.status !== "ACTIVE") return { ok: false, code: "AGENT_REVOKED", message: `Agent “${agent?.name ?? "unknown"}” was revoked; its requests are not carried out` };
  if (agent.expiresAt && agent.expiresAt <= now) return { ok: false, code: "AGENT_EXPIRED", message: `Agent “${agent.name}” expired; its requests are not carried out` };
  if (ar.state === "CANCELLED") return { ok: false, code: "AGENT_REQUEST_CANCELLED", message: `Agent request ${ar.reference} was withdrawn` };
  if (!bound(intent)) return { ok: true };

  const r = (ar.receipt as IntentReceipt).request;
  const diffs: string[] = [];
  if (intent.kind !== r.action) diffs.push(`action ${intent.kind} ≠ requested ${r.action}`);
  if (!intent.amount || normalizeMoney(intent.amount.value) !== r.amount.value || intent.amount.currency !== r.amount.currency) {
    diffs.push(`amount ${intent.amount ? `${intent.amount.value} ${intent.amount.currency}` : "none"} ≠ requested ${r.amount.value} ${r.amount.currency}`);
  }
  if (r.action === "paypal.payout" && (intent.counterparty ?? "").toLowerCase() !== r.counterparty) diffs.push(`recipient ${intent.counterparty ?? "none"} ≠ requested ${r.counterparty}`);
  if (r.action === "paypal.refund" && intent.target?.id !== r.capture_id) diffs.push(`capture ${intent.target?.id ?? "none"} ≠ requested ${r.capture_id}`);
  if (diffs.length) return { ok: false, code: "INTENT_MISMATCH", message: `Not what agent request ${ar.reference} asked for: ${diffs.join("; ")}` };
  return { ok: true };
}
