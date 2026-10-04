import { toScaled } from "../dsl/decimal";
import type { Expr, Operand } from "../dsl/expression";
import type { GraphNode, WorkflowGraph } from "../dsl/nodes";

/**
 * Boundary semantics, decided deterministically.
 *
 * People say where an exact boundary amount belongs: "under $2,500" and
 * "$2,500 or more" both put exactly $2,500 with the LARGER amounts; "up to
 * $500", "at most $500" and "over $500" put exactly $500 with the SMALLER ones.
 * A graph must place that exact amount on the same side. When the instruction
 * is unanimous about an amount, PayFlow corrects the operator itself (and says
 * so); when it contradicts itself, PayFlow asks.
 */

export type Side = "HIGH" | "LOW";

/** Phrase before the number → which side the number itself is on. */
const BEFORE: [RegExp, Side][] = [
  [/\b(?:under|below|less than|lower than|fewer than|beneath)\s*$/, "HIGH"],
  [/\b(?:at least|minimum(?: of)?|min\.?|from|starting at|no less than|not less than)\s*$/, "HIGH"],
  [/\b(?:up to|upto|at most|no more than|not more than|maximum(?: of)?|max\.?|not exceeding|within|capped at|limit of|limit to)\s*$/, "LOW"],
  [/\b(?:over|above|more than|greater than|exceeding|exceeds|in excess of|beyond|higher than|larger than|bigger than)\s*$/, "LOW"],
];
/** Phrase after the number. */
const AFTER: [RegExp, Side][] = [
  [/^\s*(?:or more|or above|or higher|or greater|or over|and above|and over|and up|\+)/, "HIGH"],
  [/^\s*(?:or less|or under|or below|or lower|and under|and below|and less)/, "LOW"],
];

const NUM = /\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\b/g;

export type StatedBoundary = { value: bigint; display: string; side: Side; phrase: string };

export function statedBoundaries(text: string): StatedBoundary[] {
  const t = text.toLowerCase();
  const out: StatedBoundary[] = [];
  for (const m of t.matchAll(NUM)) {
    const raw = m[1].replace(/,/g, "");
    const value = m[2] ? String(Number(raw) * 1000) : raw;
    let scaled: bigint;
    try {
      scaled = toScaled(value);
    } catch {
      continue;
    }
    const before = t.slice(Math.max(0, m.index! - 40), m.index!);
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 20);
    // One claim per phrase position: "no more than" also contains "more than".
    for (const [re, side] of BEFORE) {
      const hit = before.match(re);
      if (hit) {
        out.push({ value: scaled, display: m[0].trim(), side, phrase: `${hit[0].trim()} ${m[0].trim()}` });
        break;
      }
    }
    for (const [re, side] of AFTER) {
      const hit = after.match(re);
      if (hit) {
        out.push({ value: scaled, display: m[0].trim(), side, phrase: `${m[0].trim()} ${hit[0].trim()}` });
        break;
      }
    }
  }
  return out;
}

type Placement = { nodeId: string; label: string; value: bigint; side: Side; fix: () => void; describe: (s: Side) => string };

const FLIP: Record<string, string> = { gt: "lt", gte: "lte", lt: "gt", lte: "gte" };
/** For `amount OP X`: which side X itself lands on. */
const SIDE_OF_OP: Record<string, Side> = { gt: "LOW", gte: "HIGH", lt: "HIGH", lte: "LOW" };
/** The operator that puts X on a given side, keeping the comparison's direction. */
const OP_FOR: Record<string, Record<Side, string>> = {
  gt: { LOW: "gt", HIGH: "gte" },
  gte: { LOW: "gt", HIGH: "gte" },
  lt: { HIGH: "lt", LOW: "lte" },
  lte: { HIGH: "lt", LOW: "lte" },
};

function decimalConst(o: Operand): bigint | null {
  if (!("const" in o)) return null;
  const v = o.const;
  if (typeof v !== "number" && typeof v !== "string") return null;
  try {
    return toScaled(String(v));
  } catch {
    return null;
  }
}

function comparisons(expr: Expr, visit: (e: Extract<Expr, { left: Operand; right: Operand }>) => void) {
  switch (expr.op) {
    case "and":
    case "or":
      expr.args.forEach((a) => comparisons(a, visit));
      return;
    case "not":
      comparisons(expr.arg, visit);
      return;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      visit(expr);
  }
}

function placements(graph: WorkflowGraph): Placement[] {
  const out: Placement[] = [];
  const label = (n: GraphNode) => n.label ?? n.id;
  for (const n of graph.nodes) {
    const c = n.config as Record<string, unknown>;
    if (n.type === "policy.amount_limit") {
      const max = c.max as { value?: string } | undefined;
      if (!max?.value) continue;
      let value: bigint;
      try {
        value = toScaled(max.value);
      } catch {
        continue;
      }
      const comparison = (c.comparison as string | undefined) ?? "lte";
      out.push({
        nodeId: n.id,
        label: label(n),
        value,
        side: comparison === "lt" ? "HIGH" : "LOW",
        fix: () => {
          c.comparison = comparison === "lt" ? "lte" : "lt";
        },
        describe: (s) => (s === "HIGH" ? `passes only below ${max.value} (<)` : `passes at or below ${max.value} (≤)`),
      });
    }
    const exprs = [n.type === "control.condition" ? c.expr : undefined, n.type === "trigger.paypal_event" ? c.filter : undefined].filter(Boolean) as Expr[];
    for (const expr of exprs) {
      comparisons(expr, (e) => {
        const rightConst = decimalConst(e.right);
        const leftConst = decimalConst(e.left);
        if ((rightConst === null) === (leftConst === null)) return; // need exactly one constant side
        const constOnRight = rightConst !== null;
        const op = constOnRight ? e.op : FLIP[e.op];
        const value = (constOnRight ? rightConst : leftConst)!;
        out.push({
          nodeId: n.id,
          label: label(n),
          value,
          side: SIDE_OF_OP[op],
          fix: () => {
            const target = OP_FOR[op][SIDE_OF_OP[op] === "HIGH" ? "LOW" : "HIGH"];
            (e as { op: string }).op = constOnRight ? target : FLIP[target];
          },
          describe: () => `compares with ${constOnRight ? e.op : e.op} on ${value}`,
        });
      });
    }
  }
  return out;
}

export type BoundaryReview = {
  /** Operators PayFlow changed so the exact boundary lands where the instruction says. */
  corrections: { nodeId: string; message: string }[];
  /** The instruction contradicts itself about an exact amount: ask. */
  questions: { topic: string; question: string }[];
};

/**
 * Checks (and, for unanimous instructions, corrects in place) where each exact
 * boundary amount falls. Mutates `graph`; callers pass a copy and re-validate.
 */
export function reviewBoundaries(graph: WorkflowGraph, instruction: string): BoundaryReview {
  const stated = statedBoundaries(instruction);
  const review: BoundaryReview = { corrections: [], questions: [] };
  const byValue = new Map<bigint, StatedBoundary[]>();
  for (const s of stated) byValue.set(s.value, [...(byValue.get(s.value) ?? []), s]);

  for (const p of placements(graph)) {
    const claims = byValue.get(p.value);
    if (!claims?.length) continue;
    const sides = new Set(claims.map((c) => c.side));
    if (sides.size > 1) {
      const q = `Your instruction both includes and excludes exactly ${claims[0].display} (${claims.map((c) => `"${c.phrase}"`).join(", ")}). Should exactly ${claims[0].display} be treated as the larger case or the smaller case?`;
      if (!review.questions.some((x) => x.question === q)) review.questions.push({ topic: "boundary", question: q });
      continue;
    }
    const want = claims[0].side;
    if (p.side !== want) {
      p.fix();
      review.corrections.push({
        nodeId: p.nodeId,
        message: `"${p.label}": exactly ${claims[0].display} now goes with the ${want === "HIGH" ? "larger" : "smaller"} amounts, as "${claims[0].phrase}" says`,
      });
    }
  }
  return review;
}
