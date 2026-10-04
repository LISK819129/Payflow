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
    case "paypal.payout":
      return `pay ${String(c.receiverRef ?? "").replace(/^trigger\./, "")}`;
    case "paypal.refund":
      return "refund the capture";
    default:
      return SPEC_BY_TYPE[n.type]?.description ?? n.type;
  }
}
