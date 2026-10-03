/**
 * Exact decimal arithmetic for money. Amounts are strings ("4000.00") end to
 * end; they are never converted to JS floats for comparison or arithmetic.
 * Internally scaled to 6 fractional digits as BigInt.
 */
const SCALE = 6;
const FACTOR = BigInt(10) ** BigInt(SCALE);
const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

export function isDecimal(v: unknown): v is string {
  return typeof v === "string" && DECIMAL_RE.test(v);
}

export function toScaled(v: string | number): bigint {
  const s = typeof v === "number" ? numberToDecimalString(v) : v.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`not a decimal amount: ${JSON.stringify(v)}`);
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const scaled = BigInt(int) * FACTOR + BigInt((frac + "000000").slice(0, SCALE));
  return neg ? -scaled : scaled;
}

export function fromScaled(v: bigint, fractionDigits = 2): string {
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0").slice(0, fractionDigits);
  return `${neg ? "-" : ""}${int}${fractionDigits > 0 ? "." + frac : ""}`;
}

function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  // Integers and simple literals from config (e.g. 500, 0.1) only.
  return n.toFixed(6).replace(/\.?0+$/, "") || "0";
}

export function compareDecimal(a: string | number, b: string | number): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

/** |a − b| / |b| × 100, compared against `pct` without floating point. Returns -1/0/1. */
export function comparePctDiff(a: string | number, b: string | number, pct: string | number): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  if (y === BigInt(0)) return x === BigInt(0) ? (toScaled(pct) > BigInt(0) ? -1 : 0) : 1;
  const diff = x > y ? x - y : y - x;
  const base = y < BigInt(0) ? -y : y;
  // diff/base*100 vs pct  ⇔  diff*100*FACTOR vs pct_scaled*base
  const lhs = diff * BigInt(100) * FACTOR;
  const rhs = toScaled(pct) * base;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
