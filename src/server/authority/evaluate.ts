import { addDecimal, compareDecimal } from "../workflow/dsl/decimal";
import { periodWindow } from "./periods";
import { sha256 } from "../intelligence/framing";
import type { AINodeOutput } from "../intelligence/node";
import type { AuthorityRequest, AuthorityRow, BudgetSnapshot, CheckResult, Decision, Evaluation, FrequencySnapshot, Usage } from "./types";

/**
 * Pure evaluation of one authority against one request. No I/O: usage is read
 * by the caller under a lock and passed in ("unavailable" when it could not be
 * read, which fails closed to REVIEW).
 */

export const ACTION_LABEL: Record<string, string> = {
  "paypal.payout": "Payout",
  "paypal.refund": "Refund",
  "paypal.order_capture": "Order capture",
  "paypal.invoice_send": "Invoice",
  "paypal.invoice_remind": "Invoice reminder",
};

/** "1720.5" + USD → "$1,720.50". String-only: amounts never pass through a float. */
export function money(v: string, c: string): string {
  const neg = v.startsWith("-");
  const [int, frac = ""] = (neg ? v.slice(1) : v).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `${grouped}.${(frac + "00").slice(0, 2)}`;
  return `${neg ? "-" : ""}${c === "USD" ? `$${body}` : `${body} ${c}`}`;
}

const lc = (s: string) => s.trim().toLowerCase();

/**
 * What AI evidence causes, per authority. Deterministic and owner-configured;
 * the model never chooses it. Ambiguity (UNCERTAIN, unavailable, injection) can
 * only be review or deny — it can never become permission.
 */
export const INTELLIGENCE_POLICY_DEFAULTS = {
  purposeOutside: "review",
  purposeUncertain: "review",
  riskElevated: "allow",
  riskHigh: "review",
  contractMismatch: "review",
  contractUncertain: "allow",
  injection: "review",
  extractionConflict: "review",
  aiUnavailable: "review",
} as const;
export type IntelligencePolicy = { -readonly [K in keyof typeof INTELLIGENCE_POLICY_DEFAULTS]: "allow" | "review" | "deny" };
/** Keys that may never be set to "allow". */
export const NEVER_ALLOW: (keyof IntelligencePolicy)[] = ["purposeUncertain", "injection", "aiUnavailable"];

export function intelligencePolicy(a: Pick<AuthorityRow, "intelligencePolicy">): IntelligencePolicy {
  const p = { ...INTELLIGENCE_POLICY_DEFAULTS, ...(a.intelligencePolicy ?? {}) } as IntelligencePolicy;
  for (const k of NEVER_ALLOW) if (p[k] === "allow") p[k] = "review";
  return p;
}

const asResult = (v: "allow" | "review" | "deny"): CheckResult => (v === "allow" ? "pass" : v);

/** Does this evidence describe this exact request (amount and counterparty)? */
function about(o: AINodeOutput, req: AuthorityRequest): string | null {
  const s = o.subject;
  if (s?.amount && req.amount && (s.amount.currency !== req.amount.currency || compareDecimal(s.amount.value, req.amount.value) !== 0)) {
    return `AI evidence was produced for ${s.amount.value} ${s.amount.currency}, not ${req.amount.value} ${req.amount.currency}`;
  }
  if (s?.counterparty && req.counterparty && s.counterparty.toLowerCase() !== req.counterparty.toLowerCase()) {
    return `AI evidence was produced for ${s.counterparty}, not ${req.counterparty}`;
  }
  return null;
}

/** Turns the run's AI evidence into checks under this authority's intelligence policy. */
export function evaluateEvidence(a: AuthorityRow, req: AuthorityRequest): Evaluation[] {
  const ev: Evaluation[] = [];
  const p = intelligencePolicy(a);
  const e = req.evidence;
  const add = (check: Evaluation["check"], result: CheckResult, detail: string, source: "ai" | "payflow", analysisId?: string | null) => ev.push({ check, result, detail, authorityId: a.id, source, analysisId: analysisId ?? null });
  const unavailable = (o: AINodeOutput, what: string) => add(o.task === "behavior" ? "risk" : (o.task as Evaluation["check"]), asResult(p.aiUnavailable), `${what}: AI analysis unavailable (${o.unavailableReason}); a person decides`, "payflow", o.analysisId);

  // Purpose: required whenever the authority states a purpose scope.
  if (a.purposeScope) {
    const o = e?.purpose;
    const scopeHash = sha256(a.purposeScope);
    if (!o) add("purpose", "review", `This authority is limited to “${a.purposeScope.slice(0, 80)}${a.purposeScope.length > 80 ? "…" : ""}”, but no purpose analysis ran for this request`, "payflow");
    else if (about(o, req)) add("purpose", "review", about(o, req)!, "payflow", o.analysisId);
    else if (o.status === "UNAVAILABLE") unavailable(o, "Purpose");
    else if (o.purpose?.scopeHash !== scopeHash) add("purpose", "review", "The purpose analysis used a different scope than this authority's current one", "payflow", o.analysisId);
    else if (o.classification === "WITHIN_SCOPE") add("purpose", "pass", `AI interpretation: within the delegated purpose${o.purpose?.category ? ` (${o.purpose.category})` : ""}`, "ai", o.analysisId);
    else if (o.classification === "OUTSIDE_SCOPE") add("purpose", asResult(p.purposeOutside), `AI interpretation: outside the delegated purpose${o.purpose?.category ? ` (${o.purpose.category})` : ""} — ${o.purpose?.reasons[0] ?? ""}`.trim(), "ai", o.analysisId);
    else add("purpose", asResult(p.purposeUncertain), `AI could not tell whether this is within the delegated purpose${o.purpose?.reasons[0] ? ` — ${o.purpose.reasons[0]}` : ""}`, "ai", o.analysisId);
  } else if (e?.purpose && e.purpose.classification === "OUTSIDE_SCOPE" && !about(e.purpose, req)) {
    add("purpose", asResult(p.purposeOutside), `AI interpretation: outside the workflow's stated purpose`, "ai", e.purpose.analysisId);
  }

  // Behavioural risk: levels are calculated by PayFlow; the AI only explains (and may raise).
  const r = e?.risk;
  if (r?.risk) {
    const firing = r.risk.signals.filter((s) => s.severity === "elevated" || s.severity === "high").map((s) => (s.id === "amount_deviation" ? `amount ${s.value} vs usual` : s.detail));
    if (about(r, req)) add("risk", "review", about(r, req)!, "payflow", r.analysisId);
    else if (r.level === "LOW") add("risk", "pass", "Risk LOW: no behavioural signal fired", "payflow", r.analysisId);
    else if (r.level === "HIGH") add("risk", asResult(p.riskHigh), `Risk HIGH: ${firing.join(", ")}`, "payflow", r.analysisId);
    else {
      const raisedByAI = r.risk.deterministicLevel === "LOW" && r.level === "ELEVATED";
      add("risk", asResult(p.riskElevated), `Risk ${r.level}: ${raisedByAI ? "AI judged the request inconsistent with earlier payments" : firing.join(", ") || "not enough history"}`, raisedByAI ? "ai" : "payflow", r.analysisId);
    }
  }

  // Contract
  const c = e?.contract;
  if (c?.contract) {
    if (about(c, req)) add("contract", "review", about(c, req)!, "payflow", c.analysisId);
    else if (c.status === "UNAVAILABLE") unavailable(c, "Contract");
    else if (!c.contract.contractProvided) add("contract", asResult(p.contractUncertain), "No contract supplied for comparison", "payflow", c.analysisId);
    else if (c.verdict === "MATCH") add("contract", "pass", "AI interpretation: invoice consistent with the contract", "ai", c.analysisId);
    else if (c.verdict === "MISMATCH") add("contract", asResult(p.contractMismatch), `AI interpretation: invoice differs from the contract — ${c.contract.findings.find((f) => f.result === "MISMATCH")?.detail ?? "see findings"}`, "ai", c.analysisId);
    else add("contract", asResult(p.contractUncertain), `AI could not confirm the invoice against the contract${c.contract.missingInformation[0] ? ` — ${c.contract.missingInformation[0]}` : ""}`, "ai", c.analysisId);
  }

  // Extraction: source vs document conflicts are deterministic comparisons.
  const x = e?.extraction;
  if (x?.extraction?.conflicts.length && !about(x, req)) {
    add("extraction", asResult(p.extractionConflict), `The document disagrees with the request: ${x.extraction.conflicts.map((k) => `${k.field} ${k.source} vs ${k.document}`).join("; ")}`, "payflow", x.analysisId);
  }

  // Injection: any document that tried to instruct the AI.
  const injected = (e?.all ?? []).filter((o) => o.injection?.detected);
  if (injected.length) {
    const what = injected.flatMap((o) => [...o.injection.patterns.map((h) => h.pattern.replaceAll("_", " ")), ...(o.injection.modelFlagged ? ["flagged by the model"] : [])]);
    add("injection", asResult(p.injection), `A document contains instructions aimed at the AI (${[...new Set(what)].join(", ")}); they were ignored and a person must look`, "payflow", injected[0].analysisId);
  }
  return ev;
}

export function combine(results: CheckResult[]): Decision {
  if (results.includes("deny")) return "DENY";
  if (results.includes("review")) return "REVIEW";
  return "ALLOW";
}

export function evaluateAuthority(
  a: AuthorityRow,
  req: AuthorityRequest,
  usage: { budget: Usage | "unavailable" | null; frequency: Usage | "unavailable" | null },
  now: Date,
): { evaluations: Evaluation[]; budget: BudgetSnapshot | null; frequency: FrequencySnapshot | null } {
  const ev: Evaluation[] = [];
  const add = (check: Evaluation["check"], result: CheckResult, detail: string) => ev.push({ check, result, detail, authorityId: a.id });
  const what = ACTION_LABEL[req.kind] ?? req.kind;

  // Standing: an authority that is not active, or outside its window, permits nothing.
  if (a.status !== "ACTIVE") add("status", "deny", `Authority “${a.name}” is ${a.status.toLowerCase()}${a.statusReason ? `: ${a.statusReason}` : ""}`);
  else add("status", "pass", `Authority “${a.name}” is active`);
  if (a.validFrom && a.validFrom > now) add("validity", "deny", `Not valid until ${a.validFrom.toISOString().slice(0, 10)}`);
  else if (a.expiresAt && a.expiresAt <= now) add("validity", "deny", `Expired on ${a.expiresAt.toISOString().slice(0, 10)}`);
  else add("validity", "pass", a.expiresAt ? `Valid until ${a.expiresAt.toISOString().slice(0, 10)}` : "No expiry set");

  // What
  if (a.actions.includes(req.kind)) add("action", "pass", `${what} permitted`);
  else add("action", "deny", `${what} is not an action this authority permits`);

  // To whom
  const party = req.counterparty ? lc(req.counterparty) : null;
  const named = (list: { id: string; name?: string }[]) => list.find((c) => lc(c.id) === party);
  const denied = party ? named(a.deniedCounterparties) : undefined;
  if (denied) add("counterparty", "deny", `${denied.name ?? denied.id} is on the deny list`);
  else if (a.counterpartyRule === "any") add("counterparty", "pass", party ? `${req.counterparty} (any counterparty not denied)` : "No counterparty restriction");
  else if (!party) add("counterparty", "review", "No counterparty to check against the allowlist");
  else {
    const ok = named(a.counterparties);
    if (ok) add("counterparty", "pass", `${ok.name ?? ok.id} allowed`);
    else add("counterparty", "review", `${req.counterparty} is not an approved counterparty`);
  }

  // How much
  const amt = req.amount;
  const limitCcy = a.currencies[0];
  const hasLimits = !!(a.perTransactionMax || a.budgetAmount);
  if (req.movesMoney && !amt) add("currency", "deny", "No amount: a money action must state its exact amount");
  if (amt) {
    if (!a.currencies.includes(amt.currency)) add("currency", "deny", `${amt.currency} is not permitted (${a.currencies.join(", ")})`);
    else if (hasLimits && amt.currency !== limitCcy) add("currency", "deny", `Limits are in ${limitCcy}; ${amt.currency} cannot be compared without FX`);
    else add("currency", "pass", `${amt.currency} allowed`);
  }
  if (amt && a.perTransactionMax) {
    const ok = compareDecimal(amt.value, a.perTransactionMax) <= 0;
    add("per_transaction", ok ? "pass" : "review", ok ? `Transaction ${money(amt.value, amt.currency)} ≤ ${money(a.perTransactionMax, limitCcy)}` : `${money(amt.value, amt.currency)} exceeds the ${money(a.perTransactionMax, limitCcy)} per-transaction limit`);
  }

  // Budget (cumulative, including reservations still in flight)
  let budget: BudgetSnapshot | null = null;
  if (a.budgetAmount && a.budgetPeriod && amt && amt.currency === limitCcy) {
    const w = periodWindow(a.budgetPeriod, now);
    if (usage.budget === "unavailable" || usage.budget === null) {
      add("budget", "review", "Budget state could not be read; a person must decide");
    } else {
      const used = addDecimal(usage.budget.committed, usage.budget.reserved);
      const after = addDecimal(used, amt.value);
      const ok = compareDecimal(after, a.budgetAmount) <= 0;
      budget = { authorityId: a.id, limit: a.budgetAmount, currency: limitCcy, period: a.budgetPeriod, periodKey: w.key, periodLabel: w.label, committed: usage.budget.committed, reserved: usage.budget.reserved, request: amt.value, after };
      add(
        "budget",
        ok ? "pass" : "review",
        ok
          ? `${w.label}: ${money(after, limitCcy)} of ${money(a.budgetAmount, limitCcy)} after this`
          : `Would bring ${w.label} to ${money(after, limitCcy)}, over the ${money(a.budgetAmount, limitCcy)} budget`,
      );
    }
  }

  // How often
  let frequency: FrequencySnapshot | null = null;
  if (a.maxCount && a.countPeriod) {
    const w = periodWindow(a.countPeriod, now);
    if (usage.frequency === "unavailable" || usage.frequency === null) add("frequency", "review", "Frequency state could not be read; a person must decide");
    else {
      const after = usage.frequency.count + 1;
      const ok = after <= a.maxCount;
      frequency = { authorityId: a.id, max: a.maxCount, period: a.countPeriod, periodKey: w.key, periodLabel: w.label, used: usage.frequency.count, after };
      add("frequency", ok ? "pass" : "review", ok ? `${after} of ${a.maxCount} actions this ${a.countPeriod}` : `Would be action ${after} this ${a.countPeriod}; the limit is ${a.maxCount}`);
    }
  }

  ev.push(...evaluateEvidence(a, req));
  return { evaluations: ev, budget, frequency };
}
