import type { Tx } from "../db/client";
import type { approvals, authorities } from "../db/schema";
import type { EvidenceSet } from "../intelligence/evidence";
import type { PeriodWindow } from "./periods";

export type AuthorityRow = typeof authorities.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type Decision = "ALLOW" | "REVIEW" | "DENY";
/** What finally happened: a REVIEW can become ALLOW only through a person's explicit approval. */
export type AuthorityOutcome = "ALLOW" | "ALLOW_AFTER_HUMAN_APPROVAL" | "REVIEW" | "DENY";

/** The action a workflow wants to take, fully resolved. Nothing here is inferred. */
export type AuthorityRequest = {
  workspaceId: string;
  runId: string;
  nodeId: string;
  workflowId: string;
  versionId: string;
  kind: string;
  amount: { value: string; currency: string } | null;
  counterparty: string | null;
  target: { type: string; id: string } | null;
  movesMoney: boolean;
  /** Phase 7: AI evidence produced earlier in the run. Input to policy; never itself a permission. */
  evidence?: EvidenceSet;
};

export type CheckResult = "pass" | "review" | "deny";

/** One rule, its verdict and a sentence a person can read. */
export type Evaluation = {
  check: "authority" | "status" | "validity" | "action" | "counterparty" | "currency" | "per_transaction" | "budget" | "frequency" | "state" | "purpose" | "risk" | "contract" | "injection" | "extraction";
  result: CheckResult;
  detail: string;
  authorityId?: string;
  /** Where the input came from: PayFlow's own calculation, or an AI interpretation (shown differently, never as fact). */
  source?: "payflow" | "ai";
  analysisId?: string | null;
};

export type BudgetSnapshot = {
  authorityId: string;
  limit: string;
  currency: string;
  period: PeriodWindow["period"];
  periodKey: string;
  periodLabel: string;
  committed: string;
  reserved: string;
  request: string;
  after: string;
};

export type FrequencySnapshot = {
  authorityId: string;
  max: number;
  period: PeriodWindow["period"];
  periodKey: string;
  periodLabel: string;
  used: number;
  after: number;
};

export type Usage = { committed: string; reserved: string; count: number };

export type AuthorityResult = {
  decisionId: string;
  decision: Decision;
  outcome: AuthorityOutcome;
  authorityIds: string[];
  evaluations: Evaluation[];
  budget: BudgetSnapshot[];
  frequency: FrequencySnapshot[];
  /** Short reason for a REVIEW or DENY. */
  reason: string;
  provider: string;
};

/**
 * The authorization decision boundary. PayFlow's own implementation lives in
 * `internal.ts`; an external authority service (e.g. GatePal) would implement
 * the same contract. The engine never looks past this interface.
 */
export interface AuthorityProvider {
  readonly name: string;
  /**
   * CHECK and, when allowed, RESERVE — atomically, inside the caller's
   * transaction. `approval` is a person's APPROVED decision on an earlier
   * REVIEW of this exact request; it can turn REVIEW into ALLOW, never DENY.
   */
  authorize(tx: Tx, req: AuthorityRequest, opts: { approval: ApprovalRow | null; now: Date }): Promise<AuthorityResult>;
  /** Ties the reservation made by `authorize` to the execution it permitted. */
  linkExecution(tx: Tx, result: AuthorityResult, executionId: string): Promise<void>;
  /** COMMIT (PayPal did it), RELEASE (it definitely did not), HOLD (unknown: keep counting it). */
  settle(tx: Tx, executionId: string, how: "commit" | "release" | "hold", reason: string): Promise<void>;
  /** Re-checked just before PayPal is contacted: is every authority behind this execution still usable? */
  usable(tx: Tx, authorityIds: string[], now: Date): Promise<{ ok: true } | { ok: false; reason: string }>;
}
