import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { actionExecutions, workflowRuns } from "../db/schema";
import { compareDecimal, fromScaled, toScaled } from "../workflow/dsl/decimal";

/**
 * Deterministic behavioural signals: arithmetic over PayFlow's own payment
 * history, computed by code. No model is asked whether $1,900 is larger than
 * $220. The methodology is fixed and stated here, so a level can always be
 * traced to the rule that produced it:
 *
 *  new_counterparty    never paid before                                   → ELEVATED
 *  amount_deviation    vs median of earlier payments to this counterparty
 *                        n ≥ 2: ≥ +300% → HIGH, ≥ +100% → ELEVATED
 *                        n = 1: ≥ +300% → ELEVATED (one sample is weak)
 *                        (lower than usual is never a risk signal)
 *  currency_changed    differs from the last payment's currency            → ELEVATED
 *  frequency           ≥ 3 payments in 24 h and ≥ 3× the daily rate of the
 *                        previous 30 days; needs ≥ 7 days of history,
 *                        otherwise reported as "not enough history"        → ELEVATED
 *  duplicate_invoice   this invoice number was already paid to them        → HIGH
 *  repeat_amount_24h   identical amount paid to them in the last 24 h      → ELEVATED
 *
 *  Level = the most severe signal; LOW when none fires; UNCERTAIN when the
 *  request has no amount to compare.
 */

export type Severity = "none" | "info" | "elevated" | "high";
export type RiskLevel = "LOW" | "ELEVATED" | "HIGH" | "UNCERTAIN";
export type Signal = { id: string; label: string; value: string; severity: Severity; detail: string };

export type HistoryItem = { at: string; amount: string; currency: string; runId: string; paypalRef: string | null; description: string; invoiceNumbers: string[] };

export type SignalReport = {
  level: RiskLevel;
  signals: Signal[];
  history: { count: number; median: string | null; min: string | null; max: string | null; recent: HistoryItem[] };
};

const DAY = 86_400_000;

/** "INV-7781", "Invoice #7781", "invoice no. 7781" → "7781". */
export function normaliseInvoiceNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(INVOICE|INV)(NO|NUMBER)?/, "");
}

/** Invoice references found in free text (deterministic, regex-based). */
export function invoiceNumbersIn(text: string): string[] {
  const out = new Set<string>();
  const res = [/\bINV[-\s#:]?\d[\dA-Z-]{1,}\b/gi, /\binvoice\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z]{0,4}-?\d[\dA-Z-]{1,})/gi];
  for (const re of res) for (const m of text.matchAll(re)) out.add(normaliseInvoiceNumber(m[1] ?? m[0]));
  return [...out].filter((x) => x.length >= 2);
}

function textOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  return Object.values(payload as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .join(" · ");
}

function median(values: string[]): string {
  const s = [...values].sort((a, b) => compareDecimal(a, b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : fromScaled((toScaled(s[mid - 1]) + toScaled(s[mid])) / BigInt(2));
}

/** Whole-percent change from `base` to `value`, exact (no floats). */
export function pctChange(value: string, base: string): number {
  const b = toScaled(base);
  if (b === BigInt(0)) return Infinity;
  return Number(((toScaled(value) - b) * BigInt(100)) / b);
}

const rank: Record<Severity, number> = { none: 0, info: 0, elevated: 1, high: 2 };

export async function computeSignals(
  tx: Tx,
  input: { workspaceId: string; runId: string; kind: string; counterparty: string | null; amount: { value: string; currency: string } | null; invoiceNumber?: string | null; now: Date },
): Promise<SignalReport> {
  const signals: Signal[] = [];
  const rows = input.counterparty
    ? await tx
        .select({ ex: actionExecutions, payload: workflowRuns.triggerPayload })
        .from(actionExecutions)
        .innerJoin(workflowRuns, eq(workflowRuns.id, actionExecutions.runId))
        .where(
          and(
            eq(actionExecutions.workspaceId, input.workspaceId),
            eq(actionExecutions.kind, input.kind),
            eq(actionExecutions.status, "SUCCEEDED"),
            ne(actionExecutions.runId, input.runId),
            sql`lower(${actionExecutions.counterparty}) = ${input.counterparty.toLowerCase()}`,
          ),
        )
        .orderBy(desc(actionExecutions.completedAt))
        .limit(200)
    : [];
  const history: HistoryItem[] = rows
    .filter((r) => r.ex.amountValue && r.ex.currency)
    .map((r) => {
      const description = textOf(r.payload);
      return { at: (r.ex.completedAt ?? r.ex.preparedAt).toISOString(), amount: r.ex.amountValue!, currency: r.ex.currency!, runId: r.ex.runId, paypalRef: r.ex.paypalRefs[0] ?? null, description: description.slice(0, 300), invoiceNumbers: invoiceNumbersIn(description) };
    });
  const n = history.length;
  const amounts = history.map((h) => h.amount);
  const med = n ? median(amounts) : null;
  const report: SignalReport["history"] = {
    count: n,
    median: med,
    min: n ? [...amounts].sort(compareDecimal)[0] : null,
    max: n ? [...amounts].sort(compareDecimal).at(-1)! : null,
    recent: history.slice(0, 6),
  };

  if (!input.amount) return { level: "UNCERTAIN", signals: [{ id: "no_amount", label: "Amount", value: "missing", severity: "none", detail: "No amount to compare" }], history: report };
  const amt = input.amount;

  if (n === 0) signals.push({ id: "new_counterparty", label: "Counterparty", value: "NEW", severity: "elevated", detail: `${input.counterparty ?? "This counterparty"} has never been paid by PayFlow` });
  else signals.push({ id: "new_counterparty", label: "Counterparty", value: "KNOWN", severity: "none", detail: `${n} earlier payment${n === 1 ? "" : "s"}` });

  if (med) {
    const pct = pctChange(amt.value, med);
    const sev: Severity = n >= 2 ? (pct >= 300 ? "high" : pct >= 100 ? "elevated" : "none") : pct >= 300 ? "elevated" : "none";
    signals.push({ id: "amount_deviation", label: "Amount deviation", value: `${pct >= 0 ? "+" : ""}${pct}%`, severity: sev, detail: `${amt.value} ${amt.currency} vs median ${med} over ${n} payment${n === 1 ? "" : "s"} (range ${report.min}–${report.max})` });
    if (n >= 3 && compareDecimal(amt.value, report.max!) > 0) signals.push({ id: "above_max", label: "Above previous maximum", value: "yes", severity: "info", detail: `largest earlier payment was ${report.max}` });
  }

  if (n) {
    const last = history[0].currency;
    signals.push({ id: "currency_changed", label: "Currency", value: last === amt.currency ? "NORMAL" : `${last} → ${amt.currency}`, severity: last === amt.currency ? "none" : "elevated", detail: `last payment was in ${last}` });

    const t = input.now.getTime();
    const in24 = history.filter((h) => t - Date.parse(h.at) < DAY);
    const oldest = Math.min(...history.map((h) => Date.parse(h.at)));
    if (t - oldest < 7 * DAY) {
      signals.push({ id: "frequency", label: "Frequency", value: "n/a", severity: "info", detail: `not enough history (first payment ${Math.max(0, Math.floor((t - oldest) / DAY))} day(s) ago)` });
    } else {
      const prior30 = history.filter((h) => t - Date.parse(h.at) >= DAY && t - Date.parse(h.at) < 31 * DAY).length;
      const perDay = prior30 / 30;
      const count = in24.length + 1;
      const burst = count >= 3 && count >= 3 * Math.max(perDay, 1 / 30);
      signals.push({ id: "frequency", label: "Frequency", value: `${count} in 24 h`, severity: burst ? "elevated" : "none", detail: `${perDay.toFixed(2)} a day over the previous 30 days` });
    }

    const repeat = in24.find((h) => compareDecimal(h.amount, amt.value) === 0 && h.currency === amt.currency);
    if (repeat) signals.push({ id: "repeat_amount_24h", label: "Same amount in 24 h", value: "yes", severity: "elevated", detail: `${repeat.amount} ${repeat.currency} paid at ${repeat.at.slice(0, 16)} UTC${repeat.paypalRef ? ` (${repeat.paypalRef})` : ""}` });
  }

  const inv = input.invoiceNumber ? normaliseInvoiceNumber(input.invoiceNumber) : null;
  if (inv) {
    const paid = history.find((h) => h.invoiceNumbers.includes(inv));
    signals.push(
      paid
        ? { id: "duplicate_invoice", label: "Invoice number", value: "ALREADY PAID", severity: "high", detail: `invoice ${input.invoiceNumber} was paid on ${paid.at.slice(0, 10)}${paid.paypalRef ? ` (${paid.paypalRef})` : ""}` }
        : { id: "duplicate_invoice", label: "Invoice number", value: "NEW", severity: "none", detail: `${input.invoiceNumber} not seen in earlier payments` },
    );
  }

  const worst = signals.reduce((m, s) => Math.max(m, rank[s.severity]), 0);
  return { level: worst === 2 ? "HIGH" : worst === 1 ? "ELEVATED" : "LOW", signals, history: report };
}
