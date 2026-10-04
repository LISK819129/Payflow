import type { AIProvider, AIResult, AnalysisRequest } from "../ai/types";

/**
 * Deterministic stand-in for a model (MOCK_TEST). Reads the fenced input the
 * same way a model would receive it and answers with simple keyword rules, so
 * the whole pipeline (framing, schema, cache, post-processing, policy) can be
 * exercised without network calls or cost. Tests can script any response,
 * including malformed output, outages and delays. It never acts on what it reads.
 */

type Script = (req: AnalysisRequest<unknown>, n: number) => Promise<AIResult<unknown> | null> | AIResult<unknown> | null;

const usage = { inputTokens: 900, outputTokens: 250, cacheWriteTokens: 0, cacheReadTokens: 0 };

function documents(input: string) {
  const out: { id: string; text: string }[] = [];
  const re = /<document id="(d\d+)"[^>]*nonce="([0-9a-f]+)">\n([\s\S]*?)\n<\/document nonce="\2">/g;
  for (const m of input.matchAll(re)) out.push({ id: m[1], text: m[3] });
  return out;
}

function context(input: string): Record<string, unknown> {
  const m = /PAYFLOW CONTEXT \(trusted, written by PayFlow\)\n([\s\S]*?)\n\nUNTRUSTED DOCUMENTS/.exec(input);
  try {
    return m ? JSON.parse(m[1]) : {};
  } catch {
    return {};
  }
}

const OUTSIDE = /gift ?cards?|vouchers?|iphone|playstation|personal|crypto|bitcoin|jewel|vacation|adobe|creative cloud/i;
const INSIDE = /gpu|compute|cpu|instances?|storage|server|hosting|bandwidth|database|kubernetes|vm\b|virtual machine|backup|cdn/i;
const INJECTION = /ignore (all |any |the )?(previous|prior)|approve (this|the) payment|raise .*limit|change .*recipient|reveal|system prompt|you are now/i;

function quote(text: string, re: RegExp) {
  const m = re.exec(text);
  return m ? text.slice(Math.max(0, m.index), m.index + m[0].length) : "";
}

function injectionOf(docs: { id: string; text: string }[]) {
  const hit = docs.find((d) => INJECTION.test(d.text));
  return { injection_suspected: !!hit, injection_evidence: hit ? [`${hit.id}: ${quote(hit.text, INJECTION)}`] : [] };
}

function answer(schemaName: string, input: string): unknown {
  const docs = documents(input);
  const all = docs.map((d) => d.text).join("\n");
  const d1 = docs[0]?.text ?? "";
  const inj = injectionOf(docs);
  switch (schemaName) {
    case "payflow_purpose": {
      const out = OUTSIDE.test(all);
      const inside = INSIDE.test(all);
      const classification = out ? "OUTSIDE_SCOPE" : inside ? "WITHIN_SCOPE" : "UNCERTAIN";
      const q = out ? quote(all, OUTSIDE) : inside ? quote(all, INSIDE) : "";
      return {
        classification,
        category: out ? quote(all, OUTSIDE).toLowerCase() : inside ? "cloud infrastructure" : "",
        reasons: classification === "UNCERTAIN" ? ["The documents do not say clearly what is being bought"] : [out ? "The request is for items the scope does not cover" : "The request is for cloud infrastructure"],
        source_references: q ? [`d1: ${q}`] : [],
        missing_information: classification === "UNCERTAIN" ? ["what is being purchased"] : [],
        ...inj,
      };
    }
    case "payflow_contract": {
      const invoice = docs.find((d) => d.id === "d1")?.text ?? "";
      const contract = docs.find((d) => d.id === "d2")?.text ?? "";
      const fee = /(priority|expedite|processing|rush|setup|surcharge)[^\n.]{0,30}fee/i.exec(invoice);
      const feeInContract = fee && contract.toLowerCase().includes(fee[1].toLowerCase());
      if (!contract.trim()) return { verdict: "UNCERTAIN", findings: [], missing_information: ["contract text"], ...inj };
      if (fee && !feeInContract)
        return {
          verdict: "MISMATCH",
          findings: [{ aspect: "fees", result: "MISMATCH", detail: `The invoice charges a ${fee[0]} the contract does not provide for`, contract_quote: "", invoice_quote: fee[0] }],
          missing_information: [],
          ...inj,
        };
      const svc = quote(invoice, INSIDE);
      return {
        verdict: "MATCH",
        findings: [{ aspect: "service", result: "MATCH", detail: "The invoiced service is the contracted service", contract_quote: quote(contract, INSIDE), invoice_quote: svc }],
        missing_information: [],
        ...inj,
      };
    }
    case "payflow_extract": {
      const f = (re: RegExp) => {
        const m = re.exec(d1);
        return m ? { found: true, value: (m[1] ?? m[0]).trim(), quote: m[0].trim() } : { found: false, value: "", quote: "" };
      };
      return {
        counterparty: f(/^From:\s*(.+)$/im),
        invoice_number: f(/\b(INV-?\d[\dA-Z-]*)/i),
        amount: f(/Total(?: due)?:?\s*\$?\s*([\d,]+\.\d{2})/i),
        currency: f(/\b(USD|EUR|GBP)\b/),
        due_date: f(/Due(?: date)?:\s*(\d{4}-\d{2}-\d{2})/i),
        purpose: f(/(?:For|Description):\s*(.+)$/im),
        payment_terms: f(/(Net \d+)/i),
        line_items: [],
        ...inj,
      };
    }
    case "payflow_behavior": {
      const ctx = context(input) as { signals?: { severity: string; detail: string }[] };
      const flagged = (ctx.signals ?? []).filter((s) => s.severity === "elevated" || s.severity === "high");
      const odd = /resent|re-sent|duplicate|urgent|new bank|new account|asap/i.test(d1);
      return {
        assessment: odd ? "INCONSISTENT_WITH_HISTORY" : flagged.length ? "UNCERTAIN" : "CONSISTENT_WITH_HISTORY",
        explanation: flagged.length ? `PayFlow flagged ${flagged.map((s) => s.detail).join("; ")}.${odd ? " The request text also reads as an urgent re-send." : ""}` : "The request looks like earlier payments.",
        concerns: flagged.map((s) => s.detail).slice(0, 5),
        source_references: odd ? [`d1: ${quote(d1, /resent|re-sent|duplicate|urgent|new bank|new account|asap/i)}`] : [],
        ...inj,
      };
    }
    case "payflow_invoice_match": {
      const ctx = context(input) as { candidates?: { id: string; number: string }[] };
      const hit = (ctx.candidates ?? []).find((c) => c.number && d1.includes(c.number));
      return { verdict: hit ? "MATCH" : "UNCERTAIN", matched_invoice_id: hit?.id ?? "", reasons: [hit ? `The note names ${hit.number}` : "The note does not identify one invoice"], ...inj };
    }
  }
  throw new Error(`mock: unknown schema ${schemaName}`);
}

export class MockAnalysisProvider implements AIProvider {
  readonly name = "mock";
  readonly model = "mock-analyst-1";
  calls: AnalysisRequest<unknown>[] = [];
  script: Script | null = null;
  delayMs = 0;

  async analyze<T>(req: AnalysisRequest<T>): Promise<AIResult<T>> {
    this.calls.push(req as AnalysisRequest<unknown>);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const scripted = this.script ? await this.script(req as AnalysisRequest<unknown>, this.calls.length) : null;
    if (scripted) return scripted as AIResult<T>;
    const value = answer(req.schemaName, req.input);
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) return { ok: false, code: "MALFORMED_OUTPUT", message: parsed.error.issues[0]?.message ?? "", usage, model: this.model, raw: JSON.stringify(value) };
    return { ok: true, value: parsed.data, usage, model: this.model, raw: JSON.stringify(value) };
  }
  async compileWorkflow(): Promise<never> {
    throw new Error("MockAnalysisProvider does not compile workflows");
  }
  async patchWorkflow(): Promise<never> {
    throw new Error("MockAnalysisProvider does not patch workflows");
  }
}
