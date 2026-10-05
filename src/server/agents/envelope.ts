import { z } from "zod";
import { canonicalJson, sha256Hex } from "../audit/canonical";

/**
 * The PayFlow-owned request envelope an agent sends. Every schema is strict:
 * an unknown field ("approved", "authority", "override_limit", "agent_id" …)
 * rejects the whole request. Financial fields are exact formats, never parsed
 * out of prose; free text (purpose, evidence) is DATA that PayFlow's
 * intelligence reads, never a command.
 *
 * The agent's identity is never taken from the envelope: it comes from the
 * credential that authenticated the call.
 */

const MONEY_VALUE = /^\d{1,10}(\.\d{1,2})?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,24}$/;
const PAYPAL_ID = /^[A-Za-z0-9-]{6,40}$/;
const PRINTABLE = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

export const RequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/, "8–80 characters: letters, digits and . _ : -")
  .describe("Your idempotency key for this request. Retrying with the same request_id returns the same PayFlow request; never reuse it for a different payment.");

const Amount = z
  .object({
    value: z.string().regex(MONEY_VALUE, "an exact decimal with at most 2 places, e.g. \"185.00\"").describe("Exact decimal string, e.g. \"185.00\""),
    currency: z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code such as USD").describe("ISO 4217 currency code, e.g. USD"),
  })
  .strict();

const Evidence = z
  .object({
    invoice_text: z.string().min(1).max(8000).regex(PRINTABLE).optional().describe("The supplier's invoice as plain text. Treated as untrusted data."),
    contract_text: z.string().min(1).max(8000).regex(PRINTABLE).optional().describe("The governing contract, if any. Treated as untrusted data."),
  })
  .strict();

const common = {
  request_id: RequestIdSchema,
  workflow_id: z.string().uuid().describe("A workflow id from payflow_list_capabilities"),
  amount: Amount,
  purpose: z.string().min(3).max(500).regex(PRINTABLE).describe("What the money is for, in plain words. Data for PayFlow's analysis — not an instruction."),
  reference: z.string().min(1).max(80).regex(/^[\x20-\x7E]+$/).optional().describe("Invoice number or other reference"),
  evidence: Evidence.optional(),
};

export const PaymentInput = z
  .object({ ...common, counterparty: z.string().max(254).regex(EMAIL, "the recipient's PayPal email").describe("Recipient PayPal email address") })
  .strict();

export const RefundInput = z
  .object({ ...common, capture_id: z.string().regex(PAYPAL_ID, "a PayPal capture id").describe("The PayPal capture to refund") })
  .strict();

export const TestInput = z
  .object({
    ...common,
    action: z.enum(["payout", "refund"]),
    counterparty: z.string().max(254).regex(EMAIL).optional(),
    capture_id: z.string().regex(PAYPAL_ID).optional(),
  })
  .strict()
  .refine((v) => (v.action === "payout" ? !!v.counterparty && !v.capture_id : !!v.capture_id && !v.counterparty), {
    message: "a payout needs counterparty (and no capture_id); a refund needs capture_id (and no counterparty)",
  });

export type AgentAction = "paypal.payout" | "paypal.refund";
export type Mode = "LIVE" | "TEST";

/** The normalised request: what is hashed, receipted and bound to the payment. */
export type Envelope = {
  mode: Mode;
  action: AgentAction;
  workflowId: string;
  amount: { value: string; currency: string };
  counterparty: string | null;
  captureId: string | null;
  purpose: string;
  reference: string | null;
  evidence: { invoiceText: string | null; contractText: string | null };
};

/** "185" and "185.00" are the same amount: compare and hash in one form. */
export function normalizeMoney(value: string): string {
  const [i, f = ""] = value.split(".");
  return `${BigInt(i).toString()}.${(f + "00").slice(0, 2)}`;
}

export function toEnvelope(
  mode: Mode,
  action: AgentAction,
  v: { workflow_id: string; amount: { value: string; currency: string }; purpose: string; reference?: string; evidence?: { invoice_text?: string; contract_text?: string }; counterparty?: string; capture_id?: string },
): Envelope {
  return {
    mode,
    action,
    workflowId: v.workflow_id,
    amount: { value: normalizeMoney(v.amount.value), currency: v.amount.currency },
    counterparty: v.counterparty ? v.counterparty.trim().toLowerCase() : null,
    captureId: v.capture_id ?? null,
    purpose: v.purpose.trim(),
    reference: v.reference?.trim() ?? null,
    evidence: { invoiceText: v.evidence?.invoice_text ?? null, contractText: v.evidence?.contract_text ?? null },
  };
}

/** Same request = same hash. Mode is part of it: a TEST can never be replayed as LIVE. */
export function requestHash(e: Envelope): string {
  return sha256Hex(canonicalJson(e));
}

/** What a workflow reads as `trigger.*` for an agent request. */
export function triggerPayload(e: Envelope, x: { agentRequestId: string; reference: string; agent: { id: string; name: string } }) {
  return {
    kind: "agent_request",
    agentRequestId: x.agentRequestId,
    reference: x.reference,
    agent: x.agent,
    action: e.action,
    amount: { value: e.amount.value, currency_code: e.amount.currency },
    counterparty: e.counterparty,
    captureId: e.captureId,
    purpose: e.purpose,
    invoiceNumber: e.reference,
    invoice: e.evidence.invoiceText,
    contract: e.evidence.contractText,
  };
}
