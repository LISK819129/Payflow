import { addDecimal, compareDecimal } from "../workflow/dsl/decimal";
import { periodWindow } from "./periods";
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

  return { evaluations: ev, budget, frequency };
}
