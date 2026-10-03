import type { AIProvider, AIResult, CompileEnvelope, CompileRequest, PatchEnvelope, PatchRequest, WireOp } from "@/server/ai/types";

type Scripted<T> = { kind: "ok"; value: T } | { kind: "raw"; raw: string } | { kind: "error"; code: "PROVIDER_ERROR" | "REFUSED" | "RATE_LIMITED"; message: string };

/**
 * Test double for the AI boundary. Returns scripted responses in order and
 * records every request so tests can assert what the compiler sent (e.g. the
 * repair message). Never makes a network call.
 */
export class ScriptedProvider implements AIProvider {
  readonly name = "mock";
  readonly model = "mock-model";
  compileRequests: CompileRequest[] = [];
  patchRequests: PatchRequest[] = [];
  private compiles: Scripted<CompileEnvelope>[] = [];
  private patches: Scripted<PatchEnvelope>[] = [];

  onCompile(...r: Scripted<CompileEnvelope>[]) {
    this.compiles.push(...r);
    return this;
  }
  onPatch(...r: Scripted<PatchEnvelope>[]) {
    this.patches.push(...r);
    return this;
  }

  private respond<T>(queue: Scripted<T>[]): AIResult<T> {
    const next = queue.shift();
    const usage = { inputTokens: 1000, outputTokens: 400, cacheWriteTokens: 0, cacheReadTokens: 0 };
    if (!next) throw new Error("ScriptedProvider: no scripted response left");
    if (next.kind === "ok") return { ok: true, value: next.value, usage, model: this.model, raw: JSON.stringify(next.value) };
    if (next.kind === "raw") return { ok: false, code: "MALFORMED_OUTPUT", message: "The model did not return valid JSON", usage, model: this.model, raw: next.raw };
    return { ok: false, code: next.code, message: next.message, usage, model: this.model };
  }

  async compileWorkflow(req: CompileRequest) {
    this.compileRequests.push(req);
    return this.respond(this.compiles);
  }
  async patchWorkflow(req: PatchRequest) {
    this.patchRequests.push(req);
    return this.respond(this.patches);
  }
}

// ── Envelope builders ─────────────────────────────────────────────────────────
type N = { id: string; type: string; label?: string; config?: Record<string, unknown>; config_json?: string };
type E = [string, string, string]; // from, port, to

export function compiled(name: string, nodes: N[], edges: E[], extra: Partial<CompileEnvelope> = {}): CompileEnvelope {
  return {
    status: "compiled",
    interpretation: extra.interpretation ?? `Interpretation of ${name}`,
    assumptions: extra.assumptions ?? [],
    questions: [],
    unsupported: extra.unsupported ?? [],
    workflow: {
      name,
      description: `${name} (test)`,
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, label: n.label ?? n.id, config_json: n.config_json ?? JSON.stringify(n.config ?? {}) })),
      edges: edges.map(([from, port, to]) => ({ from, port, to })),
    },
  };
}

const EMPTY_WF = { name: "", description: "", nodes: [], edges: [] };

export function clarify(...questions: [string, string][]): CompileEnvelope {
  return { status: "needs_clarification", interpretation: "Needs more detail", assumptions: [], questions: questions.map(([topic, question]) => ({ topic, question })), unsupported: [], workflow: EMPTY_WF };
}

export function unsupported(request: string, reason: string): CompileEnvelope {
  return { status: "unsupported", interpretation: "Cannot do this", assumptions: [], questions: [], unsupported: [{ request, reason }], workflow: EMPTY_WF };
}

const NO_NODE = { id: "", type: "", label: "", config_json: "" };

export function op(o: Partial<WireOp> & { op: WireOp["op"] }): WireOp {
  return { node_id: "", path: "", value_json: "", label: "", node: NO_NODE, from: "", port: "", to: "", ...o };
}

export function patched(ops: WireOp[], extra: Partial<PatchEnvelope> = {}): PatchEnvelope {
  return { status: "patched", interpretation: extra.interpretation ?? "Edit", assumptions: extra.assumptions ?? [], questions: [], unsupported: [], operations: ops };
}

export function patchNode(n: N) {
  return { id: n.id, type: n.type, label: n.label ?? n.id, config_json: JSON.stringify(n.config ?? {}) };
}
