import { SPEC_BY_TYPE } from "../workflow/dsl/nodes";
import type { StepRow } from "../workflow/runtime/types";
import type { AINodeOutput } from "./node";

/**
 * The AI evidence a run produced before reaching an action, as the authority
 * engine reads it. Only completed AI steps on the executed path count; the most
 * recent of each kind wins. Evidence is input to policy, never a decision.
 */
export type EvidenceSet = {
  purpose?: AINodeOutput;
  risk?: AINodeOutput;
  contract?: AINodeOutput;
  extraction?: AINodeOutput;
  all: AINodeOutput[];
};

export function collectEvidence(steps: StepRow[]): EvidenceSet {
  const out: EvidenceSet = { all: [] };
  for (const s of steps) {
    if (!SPEC_BY_TYPE[s.nodeType]?.isAI || s.status !== "OK" || !s.output) continue;
    const o = s.output as AINodeOutput;
    out.all.push(o);
    if (o.task === "purpose") out.purpose = o;
    if (o.task === "behavior") out.risk = o;
    if (o.task === "contract") out.contract = o;
    if (o.task === "extract") out.extraction = o;
  }
  return out;
}
