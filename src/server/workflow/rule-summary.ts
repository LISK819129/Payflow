import { AGENT_REQUEST_FIELDS, SPEC_BY_TYPE, type WorkflowGraph } from "./dsl/nodes";

/**
 * A plain-language summary of one workflow next to the authority that bounds it,
 * for the Flow Builder. Read-only and descriptive: it never decides anything —
 * every request is still checked in full by the workflow and the authority engine.
 *
 *   Workflow  = what should happen (its own gates and approval steps).
 *   Authority = what it is permitted to do; the ceiling for paying without a person.
 *   Effective = what can be paid automatically: the stricter of the two.
 */

export type RequestSource = "manual" | "agent" | "paypal_event" | "schedule" | "unknown";

type Money = { value: string; currency: string };

export type RuleSummary = {
  source: RequestSource;
  eventTypes: string[];
  movesMoney: boolean;
  actions: string[];
  suppliers: string[] | null; // null: the workflow itself does not restrict recipients
  currencies: string[] | null;
  /** The workflow's own amount gate, and what happens above it. */
  amountGate: { max: Money; comparison: "lte" | "lt"; above: "approval" | "blocked" | "review" } | null;
  hasApprovalStep: boolean;
  /** Purpose wording set on the workflow's own purpose-check steps (when a step leaves it out, the authority's wording is used). */
  purposeScopes: string[];
  /** For agent-request workflows: trigger fields the graph reads that an agent request never carries (see agents/envelope triggerPayload). */
  unknownAgentFields: string[];
};


function triggerFieldsRead(graph: WorkflowGraph): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const m = /^trigger\.([A-Za-z0-9_]+)/.exec(v);
      if (m) out.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  graph.nodes.forEach((n) => visit(n.config));
  return [...out];
}

export type AuthorityTerms = {
  id: string;
  name: string;
  version: number;
  actions: string[];
  counterpartyRule: "allowlist" | "any";
  counterparties: { id: string; name?: string }[];
  denied: { id: string; name?: string }[];
  currencies: string[];
  perTransactionMax: string | null;
  budgetAmount: string | null;
  budgetPeriod: string | null;
  purposeScope: string | null;
  expiresAt: string | null;
};

export type Effective = {
  covered: boolean;
  suppliers: { list: { id: string; name: string }[] | "any"; denied: string[]; outsideAuthority: string[] };
  currencies: string[] | null;
  autoMax: Money | null;
  autoMaxFrom: "workflow" | "authority" | "both" | null;
  purpose: string | null;
  budget: string | null;
  expires: string | null;
  /**
   * An authority only accepts a purpose check made against its own exact wording. If the workflow's
   * purpose step uses different wording, every payment waits for a person — said plainly here.
   */
  purposeMismatch: { workflow: string; authority: string } | null;
};

const SOURCE: Record<string, RequestSource> = {
  "trigger.manual": "manual",
  "trigger.agent_request": "agent",
  "trigger.paypal_event": "paypal_event",
  "trigger.schedule": "schedule",
};

export function summarizeRule(graph: WorkflowGraph): RuleSummary {
  const trigger = graph.nodes.find((n) => SPEC_BY_TYPE[n.type]?.category === "trigger");
  const next = (id: string, port: string) => graph.nodes.find((n) => n.id === graph.edges.find((e) => e.from === id && e.port === port)?.to);
  const money = graph.nodes.filter((n) => SPEC_BY_TYPE[n.type]?.movesMoney);
  const suppliers = graph.nodes.filter((n) => n.type === "policy.counterparty").flatMap((n) => (n.config as { allowed: string[] }).allowed);
  const currencyLists = graph.nodes.filter((n) => n.type === "policy.currency").map((n) => (n.config as { allowed: string[] }).allowed);
  const gate = graph.nodes.find((n) => n.type === "policy.amount_limit");
  let amountGate: RuleSummary["amountGate"] = null;
  if (gate) {
    const cfg = gate.config as { max: Money; comparison?: "lte" | "lt" };
    const blockTo = next(gate.id, "block");
    const above = blockTo?.type === "control.approval" ? "approval" : blockTo?.type === "control.terminal" && (blockTo.config as { outcome?: string }).outcome === "blocked" ? "blocked" : "review";
    amountGate = { max: cfg.max, comparison: cfg.comparison ?? "lte", above };
  }
  return {
    source: trigger ? (SOURCE[trigger.type] ?? "unknown") : "unknown",
    eventTypes: trigger?.type === "trigger.paypal_event" ? ((trigger.config as { eventTypes?: string[] }).eventTypes ?? []) : [],
    movesMoney: money.length > 0,
    actions: [...new Set(money.map((n) => n.type))],
    suppliers: suppliers.length ? [...new Set(suppliers)] : null,
    currencies: currencyLists.length ? currencyLists.reduce((a, b) => a.filter((c) => b.includes(c))) : null,
    amountGate,
    hasApprovalStep: graph.nodes.some((n) => n.type === "control.approval"),
    purposeScopes: [...new Set(graph.nodes.filter((n) => n.type === "ai.purpose_classification").map((n) => (n.config as { scope?: string }).scope?.trim()).filter((x): x is string => !!x))],
    unknownAgentFields: trigger?.type === "trigger.agent_request" ? triggerFieldsRead(graph).filter((f) => !(f in AGENT_REQUEST_FIELDS)) : [],
  };
}

const cents = (v: string) => Math.round(Number(v) * 100);

/** The stricter of the workflow and every authority covering its money actions (all of them must allow). */
export function effectivePermission(rule: RuleSummary, covering: AuthorityTerms[]): Effective {
  const relevant = covering.filter((a) => rule.actions.some((k) => a.actions.includes(k)));
  const allowlists = relevant.filter((a) => a.counterpartyRule === "allowlist");
  const names = new Map(relevant.flatMap((a) => a.counterparties.map((c) => [c.id.toLowerCase(), c.name ?? c.id] as const)));
  const denied = [...new Set(relevant.flatMap((a) => a.denied.map((d) => d.name ?? d.id)))];
  const deniedIds = new Set(relevant.flatMap((a) => a.denied.map((d) => d.id.toLowerCase())));

  let list: { id: string; name: string }[] | "any" = "any";
  let candidates: string[] | null = rule.suppliers;
  for (const a of allowlists) {
    const ids = a.counterparties.map((c) => c.id.toLowerCase());
    candidates = candidates ? candidates.filter((c) => ids.includes(c.toLowerCase())) : ids;
  }
  if (candidates) list = candidates.filter((c) => !deniedIds.has(c.toLowerCase())).map((c) => ({ id: c, name: names.get(c.toLowerCase()) ?? c }));
  const outsideAuthority = rule.suppliers && allowlists.length ? rule.suppliers.filter((s) => !allowlists.every((a) => a.counterparties.some((c) => c.id.toLowerCase() === s.toLowerCase()))) : [];

  let currencies = rule.currencies;
  for (const a of relevant) currencies = currencies ? currencies.filter((c) => a.currencies.includes(c)) : [...a.currencies];

  // Largest amount paid without a person: the workflow's gate (if amounts above it are not paid automatically) and each authority's per-transaction maximum.
  let autoMax: Money | null = rule.amountGate ? rule.amountGate.max : null;
  let from: Effective["autoMaxFrom"] = autoMax ? "workflow" : null;
  for (const a of relevant) {
    if (!a.perTransactionMax) continue;
    const m = { value: a.perTransactionMax, currency: a.currencies[0] ?? "USD" };
    if (!autoMax || cents(m.value) < cents(autoMax.value)) {
      autoMax = m;
      from = "authority";
    } else if (cents(m.value) === cents(autoMax.value)) from = "both";
  }

  const scoped = relevant.filter((a) => a.purposeScope);
  const mismatch = scoped.flatMap((a) => rule.purposeScopes.filter((w) => w !== a.purposeScope!.trim()).map((w) => ({ w, a: a.purposeScope! })))[0];
  const budgets = relevant.filter((a) => a.budgetAmount && a.budgetPeriod);
  const expiring = relevant.filter((a) => a.expiresAt).sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!));
  return {
    covered: relevant.length > 0,
    suppliers: { list, denied, outsideAuthority },
    currencies,
    autoMax: relevant.length ? autoMax : null,
    autoMaxFrom: relevant.length ? from : null,
    purpose: scoped.length ? scoped.map((a) => a.purposeScope).join(" · and · ") : null,
    budget: budgets.length ? budgets.map((a) => `${money(a.budgetAmount!, a.currencies[0] ?? "USD")} a ${a.budgetPeriod}`).join(", ") : null,
    expires: expiring[0]?.expiresAt ?? null,
    purposeMismatch: mismatch ? { workflow: mismatch.w, authority: mismatch.a } : null,
  };
}

export function money(value: string, currency: string) {
  const n = Number(value);
  return `${currency === "USD" ? "$" : `${currency} `}${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
