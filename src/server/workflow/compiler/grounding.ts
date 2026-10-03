import { toScaled } from "../dsl/decimal";
import type { Expr, Operand } from "../dsl/expression";
import type { GraphNode, WorkflowGraph } from "../dsl/nodes";

/**
 * Grounding: every critical value in an AI-produced graph must come from the
 * person's instruction (or, for an edit, from the workflow being edited).
 * Critical values are amounts and limits, percentages, counterparties and
 * delays. An ungrounded value is something the model invented; the compiler
 * turns each one into a question instead of a draft.
 */

export type Ungrounded = { nodeId: string; field: string; value: string; question: string };

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
  a: 1, an: 1, single: 1, once: 1, twice: 2, week: 7, fortnight: 14,
};

/** Every number the text states, as scaled decimals (handles $4,000, 4k, 4.5 thousand, "three days"). */
export function statedNumbers(text: string): Set<bigint> {
  const out = new Set<bigint>();
  const add = (n: number | string) => {
    try {
      out.add(toScaled(typeof n === "number" ? String(n) : n));
    } catch {
      /* not a decimal */
    }
  };
  const t = text.toLowerCase();
  for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/g)) {
    const base = m[1].replace(/,/g, "");
    add(base);
    if (m[2] === "k" || m[2] === "thousand") add(String(Number(base) * 1000));
    if (m[2] === "m" || m[2] === "million") add(String(Number(base) * 1_000_000));
  }
  for (const [w, n] of Object.entries(WORD_NUMBERS)) if (new RegExp(`\\b${w}\\b`).test(t)) add(n);
  // "a week" / "two weeks" → days; "48 hours" → minutes etc. are matched by value below.
  for (const m of t.matchAll(/(\d+|\b(?:one|two|three|four|a)\b)\s*weeks?/g)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1]];
    if (n !== undefined) add(n * 7);
  }
  for (const m of t.matchAll(/(\d+|\b(?:one|two|three|a|an)\b)\s*hours?/g)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1]];
    if (n !== undefined) add(n * 60);
  }
  return out;
}

function isStated(value: string | number, stated: Set<bigint>): boolean {
  try {
    return stated.has(toScaled(String(value)));
  } catch {
    return false;
  }
}

function mentions(text: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  const t = text.toLowerCase();
  if (t.includes(v)) return true;
  // An email or domain is grounded if its distinctive part is named ("aws@amazon.com" needs "aws@amazon.com", not just "AWS").
  return false;
}

function constsIn(expr: Expr): Operand[] {
  switch (expr.op) {
    case "and":
    case "or":
      return expr.args.flatMap(constsIn);
    case "not":
      return constsIn(expr.arg);
    case "exists":
    case "missing":
      return [];
    default:
      return [expr.left, expr.right];
  }
}

function pctsIn(expr: Expr): number[] {
  switch (expr.op) {
    case "and":
    case "or":
      return expr.args.flatMap(pctsIn);
    case "not":
      return pctsIn(expr.arg);
    case "pct_diff":
      return [expr.pct];
    default:
      return [];
  }
}

const money = (v: unknown) => (v && typeof v === "object" ? String((v as { value?: unknown }).value ?? "") : "");

/**
 * @param sources the instruction, plus (for edits) the text of the existing graph,
 *                so values that were already there are not treated as invented.
 */
export function checkGrounding(graph: WorkflowGraph, sources: string[]): Ungrounded[] {
  const text = sources.join("\n");
  const stated = statedNumbers(text);
  const out: Ungrounded[] = [];
  const flag = (n: GraphNode, field: string, value: string, question: string) => out.push({ nodeId: n.id, field, value, question });
  const label = (n: GraphNode) => n.label ?? n.id;

  for (const n of graph.nodes) {
    const c = n.config as Record<string, unknown>;
    switch (n.type) {
      case "policy.amount_limit": {
        const v = money(c.max);
        if (v && !isStated(v, stated)) flag(n, "max.value", v, `What should the limit be for "${label(n)}"? (the draft proposed ${v} ${(c.max as { currency?: string })?.currency ?? ""})`);
        break;
      }
      case "policy.budget": {
        const v = money(c.budget);
        if (v && !isStated(v, stated)) flag(n, "budget.value", v, `What budget should "${label(n)}" allow? (the draft proposed ${v})`);
        break;
      }
      case "policy.counterparty":
        for (const a of (c.allowed as string[]) ?? []) {
          if (!mentions(text, a)) flag(n, "allowed", a, `Which counterparty did you mean for "${label(n)}"? "${a}" is not in your instruction — give the exact PayPal email or id.`);
        }
        break;
      case "control.condition":
      case "trigger.paypal_event": {
        const expr = (n.type === "control.condition" ? c.expr : c.filter) as Expr | undefined;
        if (!expr) break;
        for (const o of constsIn(expr)) {
          if (!("const" in o)) continue;
          const v = o.const;
          if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) {
            if (!isStated(v, stated)) flag(n, "expr", String(v), `"${label(n)}" compares against ${v}, which your instruction doesn't state. What value should it use?`);
          } else if (Array.isArray(v)) {
            for (const item of v) if (/@/.test(item) && !mentions(text, item)) flag(n, "expr", item, `"${label(n)}" uses "${item}", which your instruction doesn't mention. Who did you mean?`);
          }
        }
        for (const p of pctsIn(expr)) if (!isStated(p, stated)) flag(n, "pct", String(p), `"${label(n)}" uses a ${p}% threshold your instruction doesn't state. What percentage should it be?`);
        break;
      }
      case "control.delay": {
        for (const [k, v] of [["minutes", c.minutes], ["offsetDays", c.offsetDays]] as const) {
          if (typeof v === "number" && v !== 0 && !isStated(v, stated)) flag(n, k, String(v), `How long should "${label(n)}" wait? (the draft proposed ${k === "minutes" ? `${v} minutes` : `${v} days`})`);
        }
        break;
      }
      case "control.approval":
        if (typeof c.expiresAfterHours === "number" && !isStated(c.expiresAfterHours, stated)) {
          flag(n, "expiresAfterHours", String(c.expiresAfterHours), `How long should "${label(n)}" wait for a decision? (the draft proposed ${c.expiresAfterHours} hours)`);
        }
        break;
    }
  }
  return out;
}
