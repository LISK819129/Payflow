import { SPEC_BY_TYPE, type WorkflowGraph } from "../dsl/nodes";
import type { EndOutcome, StepRow } from "./types";

/**
 * The run's outcome text, derived from what actually happened on its path —
 * approvals decided, policy blocks, errors — rather than from an end node's
 * authored message, which may be shared by several paths ("Accepted
 * automatically" reached after a manual approval must not say so).
 */
export function describeOutcome(outcome: EndOutcome, steps: StepRow[], graph: WorkflowGraph): string {
  const label = (nodeId: string) => {
    const n = graph.nodes.find((x) => x.id === nodeId);
    return n?.label ?? (n ? SPEC_BY_TYPE[n.type]?.title : undefined) ?? nodeId;
  };
  const decided = steps.filter((s) => s.nodeType === "control.approval" && s.status === "OK");
  const approved = decided.filter((s) => s.port === "approved");
  const rejected = decided.filter((s) => s.port === "rejected");
  const expired = rejected.filter((s) => (s.output as { decision?: string } | null)?.decision === "EXPIRED");
  const blocks = steps.filter((s) => s.port === "block");
  const errors = steps.filter((s) => s.status === "ERROR");
  const paypal = steps.filter((s) => s.nodeType.startsWith("paypal.") && s.status === "OK" && s.port === "done");

  switch (outcome) {
    case "completed": {
      const actions = paypal.length ? ` · ${paypal.map((s) => label(s.nodeId)).join(", ")} done` : "";
      if (approved.length) return `Completed after approval at “${approved.map((s) => label(s.nodeId)).join("”, “")}”${actions}`;
      if (errors.length) return `Completed after a handled error at “${label(errors.at(-1)!.nodeId)}”${actions}`;
      return `Completed automatically${actions}`;
    }
    case "rejected":
      if (expired.length) return `Rejected: approval “${label(expired.at(-1)!.nodeId)}” expired without a decision`;
      if (rejected.length) return `Rejected by a person at “${label(rejected.at(-1)!.nodeId)}”`;
      return "Rejected";
    case "blocked": {
      const b = blocks.at(-1);
      return b ? `Blocked by “${label(b.nodeId)}”: ${b.explanation ?? ""}`.trim() : "Blocked";
    }
    case "needs_review": {
      const e = errors.at(-1);
      if (e) return `Needs review: ${e.explanation ?? `“${label(e.nodeId)}” failed`}`;
      const b = blocks.at(-1);
      return b ? `Needs review after “${label(b.nodeId)}”: ${b.explanation ?? ""}`.trim() : "Needs review";
    }
  }
}
