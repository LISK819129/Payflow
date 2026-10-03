import { compareDecimal } from "../dsl/decimal";
import { SPEC_BY_TYPE, type WorkflowGraph } from "../dsl/nodes";

export type ControlChange = { nodeId: string; message: string };

/**
 * Changes that weaken a workflow's controls. They are allowed (it is the
 * owner's money) but always shown prominently and need explicit confirmation.
 */
export function weakenedControls(before: WorkflowGraph, after: WorkflowGraph): ControlChange[] {
  const out: ControlChange[] = [];
  const prev = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const title = (id: string, g: Map<string, { label?: string; type: string }>) => g.get(id)?.label ?? SPEC_BY_TYPE[g.get(id)!.type]?.title ?? id;

  for (const [id, n] of prev) {
    const s = SPEC_BY_TYPE[n.type];
    if (!next.has(id)) {
      if (s?.isPolicy) out.push({ nodeId: id, message: `Removes the policy check "${title(id, prev)}"` });
      if (n.type === "control.approval") out.push({ nodeId: id, message: `Removes the human approval "${title(id, prev)}"` });
      if (n.type === "control.freeze") out.push({ nodeId: id, message: `Removes the freeze step "${title(id, prev)}"` });
      continue;
    }
    const m = next.get(id)!;
    const a = n.config as Record<string, unknown>;
    const b = m.config as Record<string, unknown>;
    const val = (x: unknown) => (x as { value?: string } | undefined)?.value;
    try {
      if (n.type === "policy.amount_limit" && val(a.max) && val(b.max) && compareDecimal(val(b.max)!, val(a.max)!) > 0) {
        out.push({ nodeId: id, message: `Raises "${title(id, next)}" from ${val(a.max)} to ${val(b.max)}` });
      }
      if (n.type === "policy.budget" && val(a.budget) && val(b.budget) && compareDecimal(val(b.budget)!, val(a.budget)!) > 0) {
        out.push({ nodeId: id, message: `Raises budget "${title(id, next)}" from ${val(a.budget)} to ${val(b.budget)}` });
      }
    } catch {
      /* malformed values are reported by the validator */
    }
    if (n.type === "policy.counterparty" || n.type === "policy.currency") {
      const before = new Set(((a.allowed as string[]) ?? []).map((x) => x.toLowerCase()));
      const added = ((b.allowed as string[]) ?? []).filter((x) => !before.has(x.toLowerCase()));
      if (added.length) out.push({ nodeId: id, message: `Allows ${added.join(", ")} in "${title(id, next)}"` });
    }
  }
  for (const [id, m] of next) {
    const s = SPEC_BY_TYPE[m.type];
    if (!prev.has(id) && (s?.movesMoney || s?.external)) out.push({ nodeId: id, message: `Adds "${title(id, next)}", which ${s.movesMoney ? "moves money" : "contacts a third party"}` });
  }
  // A block/rejected path re-pointed away from an end state can open a route around a control.
  const endTypes = new Set(["control.terminal"]);
  for (const e of after.edges) {
    if (!["block", "rejected"].includes(e.port)) continue;
    const old = before.edges.find((x) => x.from === e.from && x.port === e.port);
    const target = next.get(e.to);
    if (old && old.to !== e.to && target && !endTypes.has(target.type) && target.type !== "control.approval") {
      out.push({ nodeId: e.from, message: `"${title(e.from, next)}" ${e.port} path now continues to "${title(e.to, next)}" instead of stopping` });
    }
  }
  return out;
}
