import { z } from "zod";
import { canonicalJson } from "../audit/canonical-json";
import { compareDecimal } from "../workflow/dsl/decimal";
import { ANALYST_PREAMBLE, quoteAppears, sha256, type UntrustedDocument } from "./framing";
import { BehaviorWire, ContractWire, ExtractWire, InvoiceMatchWire, PurposeWire } from "./schemas";

/**
 * The five execution-time analyses. Each has a version, instructions, a
 * PayFlow-owned schema, and deterministic post-processing that never trusts a
 * claim it can check: quoted evidence must really appear in the documents,
 * extracted values must be present in their quote, contradictory verdicts are
 * downgraded to UNCERTAIN. A model can only ever make PayFlow more cautious.
 */

export type TaskName = "purpose" | "contract" | "extract" | "behavior" | "invoice_match";

type TaskDef = { version: string; schemaName: string; schema: z.ZodType; instructions: string };

export const TASKS: Record<TaskName, TaskDef> = {
  purpose: {
    version: "purpose-v1",
    schemaName: "payflow_purpose",
    schema: PurposeWire,
    instructions: `${ANALYST_PREAMBLE}

TASK — purpose. Decide whether the requested payment is FOR something inside the delegated purpose scope in PAYFLOW CONTEXT ("scope").
- WITHIN_SCOPE: the documents clearly describe goods or services the scope covers.
- OUTSIDE_SCOPE: they clearly describe something the scope does not cover (for example gift cards, vouchers, personal items, or software or services unrelated to the scope), or a material part of the request is outside it.
- UNCERTAIN: too vague, contradictory or missing to tell.
Judge purpose only. Amount limits, budgets, counterparties and currency are checked by PayFlow's code; do not comment on them.
category: a short label for what is being bought (e.g. "GPU compute", "gift cards"), or "" if unknown.
reasons: up to 4 short reasons. source_references: exact short quotes that support your answer.`,
  },
  contract: {
    version: "contract-v1",
    schemaName: "payflow_contract",
    schema: ContractWire,
    instructions: `${ANALYST_PREAMBLE}

TASK — contract. Compare the invoice (document d1) with the contract (document d2) for: the service supplied, prices or rates, fees and charges, the parties, and the term.
- MATCH: the invoice is consistent with the contract in every material aspect you checked.
- MISMATCH: any material inconsistency — a service the contract does not cover, a price or rate above the contract, a fee or charge the contract does not provide for, different parties.
- UNCERTAIN: the contract does not address something material, or information needed to judge is missing.
For each finding give the aspect, its result, one sentence of detail, and the exact short quotes from the contract and the invoice it rests on ("" if there is none).
Report only what the documents say; do not assume terms that are not written.`,
  },
  extract: {
    version: "extract-v1",
    schemaName: "payflow_extract",
    schema: ExtractWire,
    instructions: `${ANALYST_PREAMBLE}

TASK — extract. Read the invoice or payment request (document d1) and extract: counterparty (who is paid), invoice_number, amount (the total to pay), currency (ISO code if stated or unambiguous from a symbol), due_date, purpose (what is being paid for, in a few words), payment_terms.
For each field: found = true only if the document states it; value = the value as written ("" if not found); quote = the exact short text from the document it comes from ("" if not found).
Do not calculate, infer or fill in anything: if the total is not written, amount is not found even if line items could be added up.
line_items: the listed items as written (empty strings for parts not written).`,
  },
  behavior: {
    version: "behavior-v1",
    schemaName: "payflow_behavior",
    schema: BehaviorWire,
    instructions: `${ANALYST_PREAMBLE}

TASK — behaviour. PayFlow has already calculated behavioural signals from its own payment history (PAYFLOW CONTEXT "signals"); they are facts, do not recalculate or contradict them.
Explain to a busy business owner, in two or three plain sentences, why this request looks unusual or not, using the signals and the request text (d1) compared with earlier payment descriptions (d2 onward).
assessment: CONSISTENT_WITH_HISTORY if the request reads like the earlier ones, INCONSISTENT_WITH_HISTORY if its content or pattern differs materially (for example a re-sent invoice, new bank details, urgency, a different kind of purchase), UNCERTAIN if there is too little to compare.
concerns: up to 5 short, specific concerns. source_references: exact short quotes.`,
  },
  invoice_match: {
    version: "invoice-match-v1",
    schemaName: "payflow_invoice_match",
    schema: InvoiceMatchWire,
    instructions: `${ANALYST_PREAMBLE}

TASK — invoice match. PAYFLOW CONTEXT lists open invoices PayFlow sent ("candidates") and a received payment. Decide which single candidate the payment settles, using the payment note (d1).
matched_invoice_id: exactly one candidate id, or "" if none clearly matches. verdict: MATCH, NO_MATCH, or UNCERTAIN when more than one could fit.`,
  },
};

export const promptHash = (task: TaskName) => {
  const t = TASKS[task];
  return sha256(`${t.version}\n${t.instructions}\n${JSON.stringify(z.toJSONSchema(t.schema))}`);
};

export type AnalysisInput = { context: Record<string, unknown>; documents: UntrustedDocument[] };

/** Content address: same task + prompt/schema version + model + exact inputs ⇒ same analysis. */
export function cacheKeyFor(task: TaskName, model: string, input: AnalysisInput) {
  const docs = input.documents.map((d) => ({ id: d.id, label: d.label, sha256: sha256(d.text) }));
  return {
    cacheKey: sha256(canonicalJson({ task, version: TASKS[task].version, promptHash: promptHash(task), model, context: input.context, docs })),
    inputHash: sha256(canonicalJson({ context: input.context, docs })),
    docs,
  };
}

// ── Deterministic post-processing ──────────────────────────────────────────

const verified = (refs: string[], docs: UntrustedDocument[]) => refs.filter((r) => quoteAppears(r, docs));

export type PurposeResult = { classification: "WITHIN_SCOPE" | "OUTSIDE_SCOPE" | "UNCERTAIN"; category: string; reasons: string[]; sourceReferences: string[]; missingInformation: string[]; issues: string[] };

export function finishPurpose(w: PurposeWire, docs: UntrustedDocument[]): PurposeResult {
  const refs = verified(w.source_references, docs);
  const issues: string[] = [];
  let classification = w.classification;
  if (classification !== "UNCERTAIN" && refs.length === 0) {
    issues.push(`model answered ${classification} without evidence that appears in the documents; treated as UNCERTAIN`);
    classification = "UNCERTAIN";
  }
  return { classification, category: w.category, reasons: w.reasons, sourceReferences: refs, missingInformation: w.missing_information, issues };
}

export type ContractResult = {
  verdict: "MATCH" | "MISMATCH" | "UNCERTAIN";
  findings: { aspect: string; result: "MATCH" | "MISMATCH" | "UNCERTAIN"; detail: string; contractQuote: string; invoiceQuote: string; verified: boolean }[];
  missingInformation: string[];
  issues: string[];
};

export function finishContract(w: ContractWire, invoice: UntrustedDocument, contract: UntrustedDocument): ContractResult {
  const issues: string[] = [];
  const findings = w.findings.map((f) => ({
    aspect: f.aspect,
    result: f.result,
    detail: f.detail,
    contractQuote: f.contract_quote,
    invoiceQuote: f.invoice_quote,
    verified: (!f.contract_quote || quoteAppears(f.contract_quote, [contract])) && (!f.invoice_quote || quoteAppears(f.invoice_quote, [invoice])) && !!(f.contract_quote || f.invoice_quote),
  }));
  let verdict = w.verdict;
  if (verdict === "MATCH" && findings.some((f) => f.result === "MISMATCH")) {
    issues.push("verdict MATCH contradicts a MISMATCH finding; treated as UNCERTAIN");
    verdict = "UNCERTAIN";
  }
  if (verdict === "MATCH" && !findings.some((f) => f.verified)) {
    issues.push("verdict MATCH has no finding whose quotes appear in the documents; treated as UNCERTAIN");
    verdict = "UNCERTAIN";
  }
  if (verdict === "MISMATCH" && !findings.some((f) => f.result === "MISMATCH")) issues.push("verdict MISMATCH without a MISMATCH finding (kept: the cautious answer)");
  return { verdict, findings, missingInformation: w.missing_information, issues };
}

export type FieldProvenance = "SOURCE_PROVIDED" | "AI_EXTRACTED" | "NOT_FOUND";
export type ExtractedField = { value: string | null; provenance: FieldProvenance; quote?: string; note?: string; aiValue?: string | null };
export type ExtractResult = {
  fields: Record<"counterparty" | "invoiceNumber" | "amount" | "currency" | "dueDate" | "purpose" | "paymentTerms", ExtractedField>;
  lineItems: { description: string; quantity: string; unitPrice: string; total: string }[];
  conflicts: { field: string; source: string; document: string }[];
  issues: string[];
};

/** "$1,234.50" / "1.234,50"-free / "USD 470" → "1234.50" (two decimals), or null. */
export function normaliseAmount(raw: string): string | null {
  const m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(raw.replace(/\s/g, ""));
  if (!m) return null;
  return `${m[1].replace(/,/g, "")}.${(m[2] ?? "").padEnd(2, "0")}`;
}

function normaliseCurrency(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (s === "$" || s === "US$") return "USD";
  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  return null;
}

function normaliseDate(raw: string): string | null {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

const same = (field: string, a: string, b: string) =>
  field === "amount" ? (normaliseAmount(a) !== null && normaliseAmount(b) !== null && compareDecimal(normaliseAmount(a)!, normaliseAmount(b)!) === 0) : a.trim().toLowerCase() === b.trim().toLowerCase();

export function finishExtract(w: ExtractWire, doc: UntrustedDocument, source: Partial<Record<keyof ExtractResult["fields"], string | null>>): ExtractResult {
  const map: [keyof ExtractResult["fields"], keyof ExtractWire][] = [
    ["counterparty", "counterparty"],
    ["invoiceNumber", "invoice_number"],
    ["amount", "amount"],
    ["currency", "currency"],
    ["dueDate", "due_date"],
    ["purpose", "purpose"],
    ["paymentTerms", "payment_terms"],
  ];
  const fields = {} as ExtractResult["fields"];
  const conflicts: ExtractResult["conflicts"] = [];
  const issues: string[] = [];
  for (const [name, key] of map) {
    const f = w[key] as { found: boolean; value: string; quote: string };
    // An AI value counts only if its quote is really in the document and the value is really in its quote.
    let aiValue: string | null = null;
    let note: string | undefined;
    if (f.found && f.value) {
      const inDoc = quoteAppears(f.quote, [doc]);
      const valueInQuote = name === "amount" ? normaliseAmount(f.quote) !== null && normaliseAmount(f.value) !== null && compareDecimal(normaliseAmount(f.quote)!, normaliseAmount(f.value)!) === 0 : f.quote.toLowerCase().includes(f.value.toLowerCase().slice(0, 40)) || name === "currency" || name === "dueDate" || name === "purpose";
      if (inDoc && valueInQuote) {
        aiValue = name === "amount" ? normaliseAmount(f.value) : name === "currency" ? normaliseCurrency(f.value) : name === "dueDate" ? normaliseDate(f.value) : f.value.trim();
        if (aiValue === null) note = `could not read "${f.value}" as a ${name}`;
      } else {
        note = "the model's value could not be verified in the document; discarded";
        issues.push(`${name}: unverified extraction discarded`);
      }
    }
    const src = source[name];
    if (src) {
      fields[name] = { value: src, provenance: "SOURCE_PROVIDED", aiValue };
      if (aiValue && !same(name, src, aiValue)) conflicts.push({ field: name, source: src, document: aiValue });
    } else if (aiValue) {
      fields[name] = { value: aiValue, provenance: "AI_EXTRACTED", quote: f.quote };
    } else {
      fields[name] = { value: null, provenance: "NOT_FOUND", ...(note ? { note } : {}) };
    }
  }
  return {
    fields,
    lineItems: w.line_items.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, total: l.total })),
    conflicts,
    issues,
  };
}

export type BehaviorAI = { assessment: "CONSISTENT_WITH_HISTORY" | "INCONSISTENT_WITH_HISTORY" | "UNCERTAIN"; explanation: string; concerns: string[]; sourceReferences: string[] };

export function finishBehavior(w: BehaviorWire, docs: UntrustedDocument[]): BehaviorAI {
  return { assessment: w.assessment, explanation: w.explanation, concerns: w.concerns, sourceReferences: verified(w.source_references, docs) };
}

export function finishInvoiceMatch(w: InvoiceMatchWire, candidateIds: string[]) {
  const issues: string[] = [];
  let verdict = w.verdict;
  let matched = w.matched_invoice_id || null;
  if (matched && !candidateIds.includes(matched)) {
    issues.push(`model named "${matched}", which is not one of the candidates; treated as UNCERTAIN`);
    matched = null;
    verdict = "UNCERTAIN";
  }
  if (verdict === "MATCH" && !matched) {
    issues.push("MATCH without an invoice id; treated as UNCERTAIN");
    verdict = "UNCERTAIN";
  }
  return { verdict, matchedInvoiceId: verdict === "MATCH" ? matched : null, reasons: w.reasons, issues };
}
