import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { actionExecutions, aiAnalyses, authorities, reconciliations } from "../db/schema";
import type { GraphNode } from "../workflow/dsl/nodes";
import { resolveRef } from "../workflow/dsl/expression";
import { compareDecimal } from "../workflow/dsl/decimal";
import type { NodeResult, RunContext, RunRow, StepRow } from "../workflow/runtime/types";
import { scanForInjection, sha256, type InjectionHit, type UntrustedDocument } from "./framing";
import { ensureAnalysis, type AnalysisRow } from "./runner";
import type { BehaviorWire, ContractWire, ExtractWire, InvoiceMatchWire, PurposeWire } from "./schemas";
import { computeSignals, invoiceNumbersIn, type RiskLevel, type SignalReport } from "./signals";
import { finishBehavior, finishContract, finishExtract, finishInvoiceMatch, finishPurpose, type AnalysisInput, type BehaviorAI, type ContractResult, type ExtractResult, type PurposeResult, type TaskName } from "./tasks";

/**
 * Execution of the AI nodes. Everything measurable is done here, in code; the
 * model is called only where interpretation adds something, and only through
 * the cached runner. The node's output is EVIDENCE: the authority engine reads
 * it and its own policy decides what it causes. An analysis that cannot be
 * completed yields UNCERTAIN, never a guess.
 */

export type Money = { value: string; currency: string };

export type AINodeOutput = {
  task: TaskName;
  /** "ai": a model interpreted documents. "payflow": computed by code only (no model call was needed). */
  source: "ai" | "payflow";
  status: "OK" | "UNAVAILABLE" | "NOT_REQUIRED";
  analysisId: string | null;
  cached: boolean;
  model: string | null;
  promptVersion: string | null;
  subject: { amount: Money | null; counterparty: string | null };
  injection: { detected: boolean; patterns: InjectionHit[]; modelFlagged: boolean; modelEvidence: string[] };
  unavailableReason?: string;
  // Flat, routable verdicts (conditions may read these; money nodes may not).
  classification?: PurposeResult["classification"];
  verdict?: string;
  level?: RiskLevel;
  matchedInvoiceId?: string | null;
  purpose?: PurposeResult & { scope: string | null; scopeHash: string | null; authorityId: string | null };
  contract?: ContractResult & { contractProvided: boolean };
  extraction?: ExtractResult;
  risk?: { level: RiskLevel; deterministicLevel: RiskLevel; signals: SignalReport["signals"]; history: SignalReport["history"]; ai: BehaviorAI | null };
  invoiceMatch?: { verdict: "MATCH" | "NO_MATCH" | "UNCERTAIN"; matchedInvoiceId: string | null; method: "deterministic" | "ai"; candidates: { id: string; number: string | null; amount: string }[]; reasons: string[]; issues: string[] };
};

type Prepared = {
  task: TaskName;
  subject: AINodeOutput["subject"];
  docs: UntrustedDocument[];
  context: Record<string, unknown>;
  /** Set when no model call is needed: the final output, computed by code. */
  final?: Partial<AINodeOutput>;
  /** Turns the validated model answer into the node's evidence. */
  finish: (wire: unknown) => Partial<AINodeOutput>;
  /** Evidence when the model could not be asked or did not answer. */
  unavailable: (reason: string) => Partial<AINodeOutput>;
};

const TASK_OF: Record<string, TaskName> = {
  "ai.invoice_extract": "extract",
  "ai.contract_match": "contract",
  "ai.purpose_classification": "purpose",
  "ai.behavior_analysis": "behavior",
  "ai.invoice_match": "invoice_match",
};

function money(v: unknown): Money | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const value = typeof o.value === "string" ? o.value : null;
  const currency = typeof o.currency_code === "string" ? o.currency_code : typeof o.currency === "string" ? o.currency : null;
  return value && currency ? { value, currency } : null;
}

const text = (ctx: RunContext, ref: string | undefined) => {
  if (!ref) return null;
  const v = resolveRef(ctx as unknown as Record<string, unknown>, ref);
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
};

const SEVERITY: Record<RiskLevel, number> = { LOW: 0, UNCERTAIN: 1, ELEVATED: 1, HIGH: 2 };

async function prepare(tx: Tx, node: GraphNode, ctx: RunContext, run: RunRow, now: Date): Promise<Prepared> {
  const c = node.config as Record<string, unknown>;
  const task = TASK_OF[node.type];
  const amountAt = (ref: unknown) => (typeof ref === "string" ? money(resolveRef(ctx as unknown as Record<string, unknown>, ref)) : null);

  switch (task) {
    case "purpose": {
      const docs = (c.textRefs as string[]).map((r, i) => ({ id: `d${i + 1}`, label: r, text: text(ctx, r) ?? "" })).filter((d) => d.text);
      const subject = { amount: amountAt(c.amountRef), counterparty: text(ctx, c.counterpartyRef as string | undefined) };
      // The scope is the delegated authority's own words, so the analysis is about exactly what was delegated.
      const covering = (
        await tx
          .select({ id: authorities.id, scope: authorities.purposeScope })
          .from(authorities)
          .where(and(eq(authorities.workspaceId, run.workspaceId), eq(authorities.status, "ACTIVE"), sql`${authorities.workflowIds} @> ${JSON.stringify([run.workflowId])}::jsonb`, sql`${authorities.actions} @> ${JSON.stringify([c.action ?? "paypal.payout"])}::jsonb`))
          .orderBy(authorities.id)
      ).filter((a) => a.scope);
      const scope = (c.scope as string | undefined) ?? covering[0]?.scope ?? null;
      const meta = { scope, scopeHash: scope ? sha256(scope) : null, authorityId: c.scope ? null : (covering[0]?.id ?? null) };
      const uncertain = (reason: string): Partial<AINodeOutput> => ({ classification: "UNCERTAIN", purpose: { classification: "UNCERTAIN", category: "", reasons: [reason], sourceReferences: [], missingInformation: [], issues: [], ...meta } });
      const base = { task, subject, docs, context: { scope, action: c.action ?? "paypal.payout", amount: subject.amount ? `${subject.amount.value} ${subject.amount.currency}` : null, counterparty: subject.counterparty, categories: c.categories ?? [] } };
      if (!scope) return { ...base, final: uncertain("No purpose scope is defined for this action"), finish: () => ({}), unavailable: uncertain };
      if (docs.length === 0) return { ...base, final: uncertain("Nothing describes what the payment is for"), finish: () => ({}), unavailable: uncertain };
      return {
        ...base,
        finish: (w) => {
          const r = finishPurpose(w as PurposeWire, docs);
          return { classification: r.classification, purpose: { ...r, ...meta } };
        },
        unavailable: uncertain,
      };
    }

    case "contract": {
      const invoice = { id: "d1", label: "Invoice", text: text(ctx, c.invoiceRef as string) ?? "" };
      const contract = { id: "d2", label: "Contract", text: text(ctx, c.contractRef as string) ?? "" };
      const subject = { amount: amountAt(c.amountRef), counterparty: text(ctx, c.counterpartyRef as string | undefined) };
      const uncertain = (reason: string, provided = true): Partial<AINodeOutput> => ({ verdict: "UNCERTAIN", contract: { verdict: "UNCERTAIN", findings: [], missingInformation: [reason], issues: [], contractProvided: provided } });
      const base = { task, subject, docs: [invoice, contract].filter((d) => d.text), context: { amount: subject.amount ? `${subject.amount.value} ${subject.amount.currency}` : null, counterparty: subject.counterparty } };
      if (!contract.text) return { ...base, final: uncertain("No contract was supplied", false), finish: () => ({}), unavailable: (r) => uncertain(r, false) };
      if (!invoice.text) return { ...base, final: uncertain("No invoice text was supplied"), finish: () => ({}), unavailable: uncertain };
      return {
        ...base,
        finish: (w) => {
          const r = finishContract(w as ContractWire, invoice, contract);
          return { verdict: r.verdict, contract: { ...r, contractProvided: true } };
        },
        unavailable: uncertain,
      };
    }

    case "extract": {
      const doc = { id: "d1", label: "Invoice", text: text(ctx, c.documentRef as string) ?? "" };
      const m = amountAt(c.amountRef);
      const source = { amount: m?.value ?? null, currency: m?.currency ?? null, counterparty: text(ctx, c.counterpartyRef as string | undefined), invoiceNumber: text(ctx, c.invoiceNumberRef as string | undefined), dueDate: text(ctx, c.dueDateRef as string | undefined) };
      const subject = { amount: m, counterparty: source.counterparty };
      const fromSource = (reason: string): Partial<AINodeOutput> => {
        const nf = (v: string | null) => (v ? { value: v, provenance: "SOURCE_PROVIDED" as const } : { value: null, provenance: "NOT_FOUND" as const, note: reason });
        return {
          extraction: {
            fields: { counterparty: nf(source.counterparty), invoiceNumber: nf(source.invoiceNumber), amount: nf(source.amount), currency: nf(source.currency), dueDate: nf(source.dueDate), purpose: nf(null), paymentTerms: nf(null) },
            lineItems: [],
            conflicts: [],
            issues: [reason],
          },
        };
      };
      const base = { task, subject, docs: doc.text ? [doc] : [], context: { fields: ["counterparty", "invoice_number", "amount", "currency", "due_date", "purpose", "payment_terms"] } };
      if (!doc.text) return { ...base, final: fromSource("No document text was supplied"), finish: () => ({}), unavailable: fromSource };
      return { ...base, finish: (w) => ({ extraction: finishExtract(w as ExtractWire, doc, source) }), unavailable: fromSource };
    }

    case "behavior": {
      const amount = amountAt(c.paymentRef);
      const counterparty = text(ctx, c.counterpartyRef as string);
      const description = text(ctx, c.descriptionRef as string | undefined) ?? "";
      const invoiceNumber = text(ctx, c.invoiceNumberRef as string | undefined) ?? invoiceNumbersIn(description)[0] ?? null;
      const report = await computeSignals(tx, { workspaceId: run.workspaceId, runId: run.id, kind: (c.action as string) ?? "paypal.payout", counterparty, amount, invoiceNumber, now });
      const subject = { amount, counterparty };
      const risk = (ai: BehaviorAI | null) => {
        // The model may raise the level (content inconsistent with history), never lower what code calculated.
        const raised = ai?.assessment === "INCONSISTENT_WITH_HISTORY" && SEVERITY[report.level] < 1 ? "ELEVATED" : report.level;
        return { level: raised, risk: { level: raised, deterministicLevel: report.level, signals: report.signals, history: report.history, ai } };
      };
      const docs: UntrustedDocument[] = [
        ...(description ? [{ id: "d1", label: "This request", text: description }] : []),
        ...report.history.recent.slice(0, 5).map((h, i) => ({ id: `d${i + 2}`, label: `Earlier payment ${h.at.slice(0, 10)} ${h.amount} ${h.currency}`, text: h.description || "(no description)" })),
      ];
      const base = {
        task,
        subject,
        docs,
        context: {
          request: { amount: amount ? `${amount.value} ${amount.currency}` : null, counterparty },
          level: report.level,
          signals: report.signals.map((s) => ({ id: s.id, value: s.value, severity: s.severity, detail: s.detail })),
          history: { count: report.history.count, median: report.history.median, min: report.history.min, max: report.history.max },
        },
      };
      const explain = c.explain === "always" || report.level !== "LOW";
      if (!explain) return { ...base, final: risk(null), finish: () => ({}), unavailable: () => risk(null) };
      return { ...base, finish: (w) => risk(finishBehavior(w as BehaviorWire, docs)), unavailable: () => risk(null) };
    }

    case "invoice_match": {
      const payment = amountAt(c.paymentRef);
      const payer = text(ctx, c.counterpartyRef as string | undefined);
      const note = text(ctx, c.noteRef as string | undefined) ?? "";
      const reconciled = (await tx.select({ id: reconciliations.invoiceId }).from(reconciliations).where(eq(reconciliations.workspaceId, run.workspaceId))).map((r) => r.id);
      const sent = await tx
        .select()
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.workspaceId, run.workspaceId),
            eq(actionExecutions.kind, "paypal.invoice_send"),
            eq(actionExecutions.status, "SUCCEEDED"),
            ...(payer ? [sql`lower(${actionExecutions.counterparty}) = ${payer.toLowerCase()}`] : []),
            ...(reconciled.length ? [notInArray(sql`${actionExecutions.paypalRefs}[1]`, reconciled)] : []),
          ),
        );
      const candidates = sent.map((e) => ({ id: e.paypalRefs[0], number: ((e.result as { number?: string } | null)?.number ?? null) as string | null, amount: e.amountValue ?? "", currency: e.currency ?? "" }));
      const exact = payment ? candidates.filter((x) => x.currency === payment.currency && x.amount && compareDecimal(x.amount, payment.value) === 0) : [];
      const view = (verdict: "MATCH" | "NO_MATCH" | "UNCERTAIN", matched: string | null, method: "deterministic" | "ai", reasons: string[], issues: string[] = []): Partial<AINodeOutput> => ({
        verdict,
        matchedInvoiceId: verdict === "MATCH" ? matched : null,
        invoiceMatch: { verdict, matchedInvoiceId: matched, method, candidates: candidates.map(({ id, number, amount }) => ({ id, number, amount })), reasons, issues },
      });
      const base = { task, subject: { amount: payment, counterparty: payer }, docs: note ? [{ id: "d1", label: "Payment note", text: note }] : [], context: { payment: payment ? `${payment.value} ${payment.currency}` : null, payer, candidates: candidates.map(({ id, number, amount, currency }) => ({ id, number, amount: `${amount} ${currency}` })) } };
      if (candidates.length === 0) return { ...base, final: view("NO_MATCH", null, "deterministic", ["No open PayFlow invoice for this payer"]), finish: () => ({}), unavailable: () => ({}) };
      if (exact.length === 1) return { ...base, final: view("MATCH", exact[0].id, "deterministic", [`Exactly one open invoice for ${payment!.value} ${payment!.currency}`]), finish: () => ({}), unavailable: () => ({}) };
      if (!note) return { ...base, final: view("UNCERTAIN", null, "deterministic", [`${candidates.length} open invoices could fit and the payment carries no note`]), finish: () => ({}), unavailable: () => ({}) };
      return {
        ...base,
        finish: (w) => {
          const r = finishInvoiceMatch(w as InvoiceMatchWire, candidates.map((x) => x.id));
          return view(r.verdict, r.matchedInvoiceId, "ai", r.reasons, r.issues);
        },
        unavailable: (reason) => view("UNCERTAIN", null, "ai", [reason]),
      };
    }
  }
  throw new Error(`${node.type} is not an AI node`);
}

const injectionOf = (docs: UntrustedDocument[], wire?: { injection_suspected?: boolean; injection_evidence?: string[] }) => {
  const patterns = scanForInjection(docs);
  const modelFlagged = !!wire?.injection_suspected;
  return { detected: patterns.length > 0 || modelFlagged, patterns, modelFlagged, modelEvidence: wire?.injection_evidence ?? [] };
};

function headline(o: AINodeOutput): string {
  const how = o.source === "payflow" ? "calculated by PayFlow" : o.status === "UNAVAILABLE" ? `AI unavailable (${o.unavailableReason}); treated as UNCERTAIN` : `AI interpretation${o.cached ? " · reused from cache" : ""}`;
  const inj = o.injection.detected ? " · instructions found inside a document were ignored and flagged" : "";
  switch (o.task) {
    case "purpose":
      return `Purpose ${o.classification}${o.purpose?.category ? ` (${o.purpose.category})` : ""} — ${how}${inj}`;
    case "contract":
      return `Contract ${o.verdict}${o.contract && !o.contract.contractProvided ? " (no contract supplied)" : ""} — ${how}${inj}`;
    case "extract": {
      const f = o.extraction!.fields;
      const n = Object.values(f).filter((x) => x.provenance !== "NOT_FOUND").length;
      return `Read ${n} of 7 fields${o.extraction!.conflicts.length ? ` · ${o.extraction!.conflicts.length} conflict(s) with the request` : ""} — ${how}${inj}`;
    }
    case "behavior":
      return `Risk ${o.level}${o.risk!.ai ? ` · AI: ${o.risk!.ai.assessment.toLowerCase().replaceAll("_", " ")}` : ""} — ${o.risk!.ai ? "signals calculated by PayFlow, explained by AI" : how}${inj}`;
    case "invoice_match":
      return `Invoice ${o.verdict}${o.invoiceMatch?.matchedInvoiceId ? ` ${o.invoiceMatch.matchedInvoiceId}` : ""} — ${o.invoiceMatch?.method === "deterministic" ? "matched by PayFlow" : how}`;
  }
}

/**
 * The AI node step. Returns the evidence, or asks the engine to run the
 * analysis outside the transaction ("analyze") and come back.
 */
export async function aiNodeResult(
  tx: Tx,
  a: { node: GraphNode; ctx: RunContext; run: RunRow; waiting: StepRow | null; now: Date },
): Promise<NodeResult | { kind: "analyze"; analysisId: string; explanation: string; output: unknown }> {
  const p = await prepare(tx, a.node, a.ctx, a.run, a.now);
  const common = (row: AnalysisRow | null, cached: boolean) => ({
    task: p.task,
    analysisId: row?.id ?? null,
    cached,
    model: row?.model ?? null,
    promptVersion: row?.promptVersion ?? null,
    subject: p.subject,
  });
  const done = (o: AINodeOutput): NodeResult => ({ kind: "next", port: "done", output: o, explanation: headline(o) });

  if (p.final) return done({ ...common(null, false), source: "payflow", status: "NOT_REQUIRED", injection: injectionOf(p.docs), ...p.final } as AINodeOutput);

  const fromRow = (row: AnalysisRow, cached: boolean): NodeResult => {
    if (row.status === "OK") {
      const wire = row.output as { injection_suspected?: boolean; injection_evidence?: string[] };
      return done({ ...common(row, cached), source: "ai", status: "OK", injection: injectionOf(p.docs, wire), ...p.finish(row.output) } as AINodeOutput);
    }
    const reason = (row.error ?? "unavailable").split(":")[0];
    return done({ ...common(row, false), source: "ai", status: "UNAVAILABLE", unavailableReason: reason, injection: injectionOf(p.docs), ...p.unavailable(`AI analysis unavailable (${reason})`) } as AINodeOutput);
  };

  const waitingOn = (a.waiting?.output as { analysisId?: string } | null)?.analysisId;
  if (waitingOn) {
    const [row] = await tx.select().from(aiAnalyses).where(eq(aiAnalyses.id, waitingOn));
    if (row && row.status !== "PENDING") return fromRow(row, false);
    return { kind: "analyze", analysisId: waitingOn, explanation: `${a.node.label ?? p.task}: analysing`, output: { analysisId: waitingOn } };
  }
  const input: AnalysisInput = { context: p.context, documents: p.docs };
  const { row, hit } = await ensureAnalysis(tx, { workspaceId: a.run.workspaceId, task: p.task, analysis: input, runId: a.run.id });
  if (row.status !== "PENDING") return fromRow(row, hit);
  return { kind: "analyze", analysisId: row.id, explanation: `${a.node.label ?? p.task}: analysing`, output: { analysisId: row.id } };
}
