/**
 * The execution boundary between PayFlow's workflow runtime and anything that
 * moves money or contacts a third party.
 *
 * A workflow node never calls PayPal. It produces an ActionIntent: a
 * provider-neutral, fully resolved description of one action (exact decimal
 * amount, explicit currency, counterparty, target object, idempotency key) plus
 * the authorization evidence from the run (which policy gates passed, which
 * approvals were granted). An ActionGateway executes intents.
 *
 * Today: PayFlow → DirectPayPalGateway → PayPal.
 * Later a protected action can route through another layer without touching
 * nodes or the runtime: PayFlow → (authorization / trust gateway) → PayPal.
 */

export type ActionKind =
  | "paypal.refund"
  | "paypal.payout"
  | "paypal.order_capture"
  | "paypal.invoice_send"
  | "paypal.invoice_remind"
  | "paypal.fetch"
  | "paypal.transaction_search"
  | "ledger.reconcile";

export type GateEvidence = { nodeId: string; nodeType: string; port: string; explanation: string | null };

export type ActionIntent = {
  kind: ActionKind;
  /** Stable for the (run, node) pair; sent to PayPal as PayPal-Request-Id. */
  idempotencyKey: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  /** Exact decimal string + explicit ISO currency, when the action involves money. */
  amount: { value: string; currency: string } | null;
  counterparty: string | null;
  /** The PayPal object the action applies to (capture, order, invoice…). */
  target: { type: string; id: string } | null;
  /** Remaining kind-specific, non-secret parameters. */
  params: Record<string, unknown>;
  movesMoney: boolean;
  external: boolean;
  /** Why this action is allowed: every gate passed on the executed path. */
  authorization: {
    gates: GateEvidence[];
    /** Phase 6: the delegated-authority decision that permitted this action (protected kinds only). */
    authority?: { provider: string; decisionId: string; outcome: string; authorityIds: string[]; reason: string };
  };
  provenance: "REAL_PAYPAL_SANDBOX";
};

export type ActionOutcome =
  | {
      status: "succeeded";
      /** PayPal ids created or touched (refund id, batch id, invoice id…). */
      paypalRefs: string[];
      paypalStatus: string | null;
      debugId: string | null;
      /** Safe, displayable summary of the result. */
      result: Record<string, unknown>;
    }
  | {
      status: "failed";
      /** True when the request may not have reached PayPal (network/5xx): safe to replay with the same key. */
      retryable: boolean;
      error: { code: string; message: string; status?: number; debugId?: string | null; details?: unknown };
      paypalRefs?: string[];
    };

export type GatewayContext = {
  /** Persists intermediate PayPal ids (e.g. an invoice created before it is sent) before the next call. */
  checkpoint(refs: string[], partial: Record<string, unknown>): Promise<void>;
  /** Partial result from an earlier attempt, so a replay resumes rather than repeats. */
  previous: Record<string, unknown> | null;
  /** 1 on the first send; higher means an earlier attempt may already have reached PayPal. */
  attempt: number;
};

export interface ActionGateway {
  readonly name: string;
  execute(intent: ActionIntent, ctx: GatewayContext): Promise<ActionOutcome>;
}
