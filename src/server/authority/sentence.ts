import { intelligencePolicy, money } from "./evaluate";
import type { AuthorityRow } from "./types";

const VERB: Record<string, string> = {
  "paypal.payout": "pay",
  "paypal.refund": "refund",
  "paypal.order_capture": "capture orders from",
  "paypal.invoice_send": "invoice",
  "paypal.invoice_remind": "send invoice reminders to",
};

const list = (xs: string[], conj = "and") => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${conj} ${xs.at(-1)}`);

/**
 * One authority as a sentence a person can read before the structured detail:
 * "Cloud procurement may pay Acme Cloud and AWS up to $500.00 USD per
 *  transaction, up to $5,000.00 a month, for cloud infrastructure. Anything
 *  outside that purpose, or over these limits, goes to a person."
 */
export function authoritySentence(a: Pick<AuthorityRow, "name" | "actions" | "counterpartyRule" | "counterparties" | "currencies" | "perTransactionMax" | "budgetAmount" | "budgetPeriod" | "maxCount" | "countPeriod" | "expiresAt" | "purposeScope" | "intelligencePolicy">, workflowNames: string[]): string {
  const ccy = a.currencies[0] ?? "USD";
  const who = workflowNames.length ? list(workflowNames) : `“${a.name}”`;
  const verbs = list(a.actions.map((k) => VERB[k] ?? k));
  const whom = a.counterpartyRule === "any" ? "anyone not on the deny list" : list(a.counterparties.map((c) => c.name ?? c.id)) || "no one yet";
  const limits: string[] = [];
  if (a.perTransactionMax) limits.push(`up to ${money(a.perTransactionMax, ccy)}${ccy === "USD" ? " USD" : ""} per transaction`);
  if (a.budgetAmount && a.budgetPeriod) limits.push(`up to ${money(a.budgetAmount, ccy)} a ${a.budgetPeriod}`);
  if (a.maxCount && a.countPeriod) limits.push(`at most ${a.maxCount} time${a.maxCount === 1 ? "" : "s"} a ${a.countPeriod}`);
  let s = [`${who} may ${verbs} ${whom}`, limits.join(", ")].filter(Boolean).join(" ");
  if (a.purposeScope) s += `, for ${a.purposeScope.charAt(0).toLowerCase()}${a.purposeScope.slice(1).replace(/\.$/, "")}`;
  if (a.expiresAt) s += `, until ${a.expiresAt.toISOString().slice(0, 10)}`;
  s += ".";
  const p = intelligencePolicy(a);
  const toPerson = [a.purposeScope && p.purposeOutside !== "allow" ? "outside that purpose" : null, "over these limits", a.counterpartyRule === "allowlist" ? "to anyone else" : null].filter(Boolean) as string[];
  s += ` Anything ${list(toPerson, "or")} goes to a person${p.purposeOutside === "deny" ? " or is refused" : ""}.`;
  return s;
}
