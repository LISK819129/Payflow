import { describeExpr, type Expr } from "@/server/workflow/dsl/expression";
import { SPEC_BY_TYPE, type GraphNode } from "@/server/workflow/dsl/nodes";

/** One-line summary shown under a node's title on the canvas. Isomorphic: no server-only imports. */
export function summarizeNode(n: GraphNode): string {
  const c = n.config as Record<string, unknown>;
  const money = (m: unknown) => {
    const o = m as { value?: string; currency?: string } | undefined;
    return o?.value ? `${o.value} ${o.currency ?? ""}`.trim() : "?";
  };
  switch (n.type) {
    case "trigger.paypal_event":
      return ((c.eventTypes as string[]) ?? []).join(", ") + (c.filter ? " · filtered" : "");
    case "trigger.schedule":
      return `cron ${c.cron} ${c.timezone ?? "UTC"}`;
    case "trigger.manual":
      return "Started by a person";
    case "control.condition":
      return c.expr ? describeExpr(c.expr as Expr) : "no condition";
    case "control.approval":
      return String(c.reason ?? "");
    case "control.delay":
      return c.untilRef
        ? `${c.offsetDays ?? 0} days after ${String(c.untilRef).replace(/^trigger\./, "")}`
        : `${c.minutes ?? 0} minutes`;
    case "control.freeze":
      return String(c.reason ?? "");
    case "control.terminal":
      return `${String(c.outcome ?? "").replace("_", " ")} · ${c.message ?? ""}`;
    case "policy.amount_limit":
      return `${c.comparison === "lt" ? "<" : "≤"} ${money(c.max)}`;
    case "policy.currency":
      return `${((c.allowed as string[]) ?? []).join(", ")} only`;
    case "policy.counterparty":
      return `${((c.allowed as string[]) ?? []).length} approved counterparties`;
    case "policy.budget":
      return `${money(c.budget)} per ${c.period}`;
    case "policy.frequency":
      return `≤ ${String(c.max)} per ${String(c.period)}`;
    case "ai.purpose_classification":
      return c.scope ? "purpose vs stated scope" : "purpose vs the authority's scope";
    case "ai.invoice_extract":
      return "read the invoice · evidence only";
    case "ai.contract_match":
      return "invoice vs contract · evidence only";
    case "ai.behavior_analysis":
      return "history signals by code · AI explains";
    case "ai.invoice_match":
      return "match payment to open invoice";
    case "paypal.payout":
      return `pay ${String(c.amountRef ?? "").replace(/^trigger\./, "")} to ${String(c.receiverRef ?? "").replace(/^trigger\./, "")}`;
    case "paypal.refund":
      return `refund ${String(c.amountRef ?? "").replace(/^trigger\./, "")} of ${String(c.captureIdRef ?? "").replace(/^trigger\./, "")}`;
    case "paypal.order_capture":
      return `capture ${String(c.orderIdRef ?? "").replace(/^trigger\./, "")} if ${String(c.amountRef ?? "").replace(/^trigger\./, "")}`;
    case "paypal.invoice_send":
      return `invoice ${String(c.recipientRef ?? "").replace(/^trigger\./, "")} · ${String(c.description ?? "")}`;
    case "paypal.invoice_remind":
      return `remind ${String(c.invoiceIdRef ?? "").replace(/^trigger\./, "")}`;
    case "paypal.transaction_search":
      return `last ${String(c.days ?? "?")} days`;
    default:
      return SPEC_BY_TYPE[n.type]?.description ?? n.type;
  }
}
