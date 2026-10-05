import { Check, Hand, X } from "lucide-react";
import { money } from "@/server/authority/evaluate";
import type { Evaluation } from "@/server/authority/types";
import { addDecimal, compareDecimal } from "@/server/workflow/dsl/decimal";

/**
 * The authority engine's own checks as one readable line:
 * Supplier ✓ Currency ✓ Amount ✓ Budget ✓ Purpose ✕ → a person decides.
 * Every mark comes from a stored evaluation; nothing here is inferred.
 */
const LABEL: Record<string, string> = {
  authority: "Authority",
  status: "Authority active",
  validity: "Valid now",
  action: "Action allowed",
  counterparty: "Supplier",
  currency: "Currency",
  per_transaction: "Amount",
  budget: "Budget",
  frequency: "Frequency",
  purpose: "Purpose",
  risk: "Risk",
  contract: "Contract",
  injection: "No hidden instructions",
  extraction: "Invoice matches",
  state: "AI evidence",
};
// The order a person reads a payment in. Housekeeping checks (status, validity, action) collapse into "Authority".
const ORDER = ["counterparty", "currency", "per_transaction", "budget", "frequency", "purpose", "risk", "contract", "injection", "extraction", "state"];

type Mark = { key: string; label: string; result: "pass" | "review" | "deny"; detail: string; ai: boolean };

function Chip({ m }: { m: Mark }) {
  const cls = m.result === "pass" ? "border-line text-ink" : m.result === "review" ? "border-warn bg-warn-wash text-warn" : "border-danger bg-danger-wash text-danger";
  return (
    <li title={m.detail} className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-body-sm font-medium ${cls}`}>
      {m.result === "pass" ? (
        <Check size={14} strokeWidth={2.75} className="text-marker-ink" aria-hidden />
      ) : (
        <X size={14} strokeWidth={2.75} aria-hidden />
      )}
      <span>{m.label}</span>
      <span className="sr-only">{m.result === "pass" ? "passed" : m.result === "review" ? "needs a person" : "refused"}</span>
      {m.ai && <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-marker-ink">AI</span>}
    </li>
  );
}

export function DecisionChecks({
  evaluations,
  decision,
  amount,
  limits = [],
  agent,
  humanDecision,
}: {
  evaluations: Evaluation[];
  decision: "ALLOW" | "REVIEW" | "DENY" | string;
  amount?: { value: string; currency: string } | null;
  /** Per-transaction limits of the authorities evaluated (from the decision's snapshot). */
  limits?: (string | null)[];
  /** For agent requests: identity and scope already passed at the gateway. */
  agent?: { name: string } | null;
  humanDecision?: string | null;
}) {
  const byCheck = new Map<string, Mark>();
  for (const e of evaluations) {
    const key = ["status", "validity", "action", "authority"].includes(e.check) ? "authority" : e.check;
    const prev = byCheck.get(key);
    const worse = !prev || (e.result === "deny" ? true : e.result === "review" && prev.result === "pass");
    if (worse) byCheck.set(key, { key, label: LABEL[key] ?? key, result: e.result, detail: e.detail, ai: e.source === "ai" });
  }
  const marks: Mark[] = [];
  if (agent) {
    marks.push({ key: "identity", label: "Identity", result: "pass", detail: `Authenticated as ${agent.name}`, ai: false });
    marks.push({ key: "scope", label: "Agent scope", result: "pass", detail: "This agent may ask for this action through this workflow", ai: false });
  }
  const auth = byCheck.get("authority");
  if (auth && auth.result !== "pass") marks.push(auth);
  for (const k of ORDER) {
    const m = byCheck.get(k);
    if (m) marks.push(m);
  }

  const over = byCheck.get("per_transaction")?.result === "review" && amount ? limits.filter((l): l is string => !!l).sort(compareDecimal)[0] : null;
  const excess = over && amount && compareDecimal(amount.value, over) > 0 ? addDecimal(amount.value, `-${over}`) : null;
  const failing = marks.filter((m) => m.result !== "pass");

  const verdict =
    decision === "DENY"
      ? { text: "Refused", cls: "text-danger" }
      : decision === "REVIEW"
        ? humanDecision === "APPROVED"
          ? { text: "Approved once by a person", cls: "text-marker-ink" }
          : humanDecision && humanDecision !== "PENDING"
            ? { text: humanDecision === "EXPIRED" ? "Review expired" : "Rejected by a person", cls: "text-danger" }
            : { text: "A person must approve", cls: "text-warn" }
        : { text: "Allowed automatically", cls: "text-marker-ink" };

  return (
    <div className="rounded border border-line bg-surface px-4 py-3.5" aria-label="Why PayFlow decided this">
      <ul className="flex flex-wrap items-center gap-1.5">
        {marks.map((m) => (
          <Chip key={m.key} m={m} />
        ))}
        <li aria-hidden className="px-1 text-faint">
          →
        </li>
        <li className={`inline-flex items-center gap-1.5 text-body font-semibold ${verdict.cls}`}>
          {decision === "REVIEW" && <Hand size={15} aria-hidden />}
          {verdict.text}
        </li>
      </ul>
      {failing.length > 0 && (
        <ul className="mt-2.5 space-y-0.5 text-body-sm text-ink-2">
          {failing.map((m) => (
            <li key={m.key}>
              <span className="font-medium text-ink">{m.label}:</span> {m.key === "per_transaction" && excess && amount ? `exceeds the delegated limit by ${money(excess, amount.currency)} — ${m.detail}` : m.detail}
              {m.ai && <span className="ml-1 font-mono text-[10px] font-semibold uppercase text-marker-ink">AI evidence · the policy decided</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
