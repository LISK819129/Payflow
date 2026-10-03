import { z } from "zod";
import { compareDecimal, comparePctDiff, isDecimal } from "./decimal";

/**
 * The condition language. An expression is a small typed tree evaluated by the
 * fixed interpreter below. Nothing here is executed as code: no eval, no
 * Function, no templates. A model can emit this JSON, but it can only ever
 * describe comparisons over values the runtime already holds.
 *
 * References: `trigger.<path>`, `nodes.<nodeId>.<path>`, `workflow.<path>`.
 */

export const REF_RE = /^(trigger|nodes|workflow)(\.[A-Za-z0-9_-]+){1,8}$/;

export const Ref = z.string().regex(REF_RE, "reference must look like trigger.amount.value or nodes.n2.risk");

const ConstValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null(), z.array(z.string().max(200)).max(100)]);

export const Operand = z.union([z.object({ ref: Ref }).strict(), z.object({ const: ConstValue }).strict()]);
export type Operand = z.infer<typeof Operand>;

const CompareOp = z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]);

export type Expr =
  | { op: "and" | "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: z.infer<typeof CompareOp>; left: Operand; right: Operand }
  | { op: "in" | "not_in"; left: Operand; right: Operand }
  | { op: "exists" | "missing"; ref: string }
  | { op: "pct_diff"; left: Operand; right: Operand; cmp: "gt" | "lte"; pct: number };

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or"]), args: z.array(Expr).min(1).max(20) }).strict(),
    z.object({ op: z.literal("not"), arg: Expr }).strict(),
    z.object({ op: CompareOp, left: Operand, right: Operand }).strict(),
    z.object({ op: z.enum(["in", "not_in"]), left: Operand, right: Operand }).strict(),
    z.object({ op: z.enum(["exists", "missing"]), ref: Ref }).strict(),
    z
      .object({ op: z.literal("pct_diff"), left: Operand, right: Operand, cmp: z.enum(["gt", "lte"]), pct: z.number().min(0).max(100000) })
      .strict(),
  ]),
);

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Resolves a dotted reference against the run context using own properties only. */
export function resolveRef(ctx: Record<string, unknown>, ref: string): unknown {
  let cur: unknown = ctx;
  for (const key of ref.split(".")) {
    if (FORBIDDEN_KEYS.has(key)) throw new ExpressionError(`illegal reference segment "${key}"`);
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function operand(ctx: Record<string, unknown>, o: Operand): unknown {
  return "ref" in o ? resolveRef(ctx, o.ref) : o.const;
}

/** Money objects compare by value and must share a currency. */
function asComparable(v: unknown): { kind: "decimal"; value: string; currency?: string } | { kind: "string"; value: string } | { kind: "bool"; value: boolean } {
  if (v && typeof v === "object" && "value" in v && ("currency_code" in v || "currency" in v)) {
    const m = v as { value: unknown; currency_code?: unknown; currency?: unknown };
    if (!isDecimal(m.value)) throw new ExpressionError(`money value is not a decimal: ${JSON.stringify(m.value)}`);
    return { kind: "decimal", value: m.value, currency: String(m.currency_code ?? m.currency) };
  }
  if (typeof v === "number") return { kind: "decimal", value: String(v) };
  if (isDecimal(v)) return { kind: "decimal", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  throw new ExpressionError(`cannot compare value ${JSON.stringify(v)}`);
}

function compare(a: unknown, b: unknown): -1 | 0 | 1 {
  if (a === undefined || b === undefined) throw new ExpressionError("comparison with a missing value");
  const x = asComparable(a);
  const y = asComparable(b);
  if (x.kind === "decimal" && y.kind === "decimal") {
    if (x.currency && y.currency && x.currency !== y.currency) {
      throw new ExpressionError(`currency mismatch: ${x.currency} vs ${y.currency}`);
    }
    return compareDecimal(x.value, y.value);
  }
  if (x.kind !== y.kind) throw new ExpressionError(`type mismatch: ${x.kind} vs ${y.kind}`);
  return x.value === y.value ? 0 : x.value < y.value ? -1 : 1;
}

function decimalOf(v: unknown): string {
  const c = asComparable(v);
  if (c.kind !== "decimal") throw new ExpressionError(`expected a number or amount, got ${JSON.stringify(v)}`);
  return c.value;
}

/**
 * Evaluates an expression. Missing data or mismatched types throw
 * ExpressionError; the runtime turns that into the node's `error` outcome so an
 * uncertain condition can never silently evaluate to "pass".
 */
export function evaluate(expr: Expr, ctx: Record<string, unknown>): boolean {
  switch (expr.op) {
    case "and":
      return expr.args.every((e) => evaluate(e, ctx));
    case "or":
      return expr.args.some((e) => evaluate(e, ctx));
    case "not":
      return !evaluate(expr.arg, ctx);
    case "exists":
      return resolveRef(ctx, expr.ref) !== undefined && resolveRef(ctx, expr.ref) !== null;
    case "missing":
      return resolveRef(ctx, expr.ref) === undefined || resolveRef(ctx, expr.ref) === null;
    case "in":
    case "not_in": {
      const needle = operand(ctx, expr.left);
      const hay = operand(ctx, expr.right);
      if (!Array.isArray(hay)) throw new ExpressionError("right side of `in` must be a list");
      if (needle === undefined) throw new ExpressionError("left side of `in` is missing");
      const found = hay.some((h) => String(h).toLowerCase() === String(needle).toLowerCase());
      return expr.op === "in" ? found : !found;
    }
    case "pct_diff": {
      const r = comparePctDiff(decimalOf(operand(ctx, expr.left)), decimalOf(operand(ctx, expr.right)), expr.pct);
      return expr.cmp === "gt" ? r > 0 : r <= 0;
    }
    default: {
      const c = compare(operand(ctx, expr.left), operand(ctx, expr.right));
      switch (expr.op) {
        case "eq":
          return c === 0;
        case "neq":
          return c !== 0;
        case "lt":
          return c < 0;
        case "lte":
          return c <= 0;
        case "gt":
          return c > 0;
        case "gte":
          return c >= 0;
      }
    }
  }
}

/** Every reference an expression reads; used by the validator to check data dependencies. */
export function exprRefs(expr: Expr): string[] {
  switch (expr.op) {
    case "and":
    case "or":
      return expr.args.flatMap(exprRefs);
    case "not":
      return exprRefs(expr.arg);
    case "exists":
    case "missing":
      return [expr.ref];
    default:
      return [expr.left, expr.right].flatMap((o) => ("ref" in o ? [o.ref] : []));
  }
}

/** Short human-readable rendering for the inspector, explanations and audit. */
export function describeExpr(expr: Expr): string {
  const o = (x: Operand) => ("ref" in x ? x.ref : JSON.stringify(x.const));
  const sym = { eq: "=", neq: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥" } as const;
  switch (expr.op) {
    case "and":
    case "or":
      return expr.args.map((a) => `(${describeExpr(a)})`).join(` ${expr.op.toUpperCase()} `);
    case "not":
      return `NOT (${describeExpr(expr.arg)})`;
    case "exists":
      return `${expr.ref} is present`;
    case "missing":
      return `${expr.ref} is missing`;
    case "in":
      return `${o(expr.left)} in ${o(expr.right)}`;
    case "not_in":
      return `${o(expr.left)} not in ${o(expr.right)}`;
    case "pct_diff":
      return `|${o(expr.left)} − ${o(expr.right)}| ${expr.cmp === "gt" ? ">" : "≤"} ${expr.pct}%`;
    default:
      return `${o(expr.left)} ${sym[expr.op]} ${o(expr.right)}`;
  }
}
