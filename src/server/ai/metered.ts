import { estimateCost } from "./pricing";
import type { AIProvider, AIResult, CompileRequest, PatchRequest } from "./types";
import { assertWithinBudget, recordUsage } from "./usage";

/**
 * Wraps any provider with the hard budget: a call is refused if its worst-case
 * cost would cross the lifetime budget, and every call (success or failure)
 * is recorded with its real token usage.
 */
export class MeteredProvider implements AIProvider {
  constructor(
    private readonly inner: AIProvider,
    private readonly ctx: { workspaceId?: string | null },
    /** Worst-case input/output tokens per call, for the pre-call budget check. */
    private readonly worstCase = { inputTokens: 12_000, outputTokens: 16_000 },
  ) {}

  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }

  private async metered<T>(purpose: string, call: () => Promise<AIResult<T>>): Promise<AIResult<T>> {
    const guard = await assertWithinBudget(estimateCost(this.model, this.worstCase.inputTokens, this.worstCase.outputTokens));
    if (!guard.ok) return { ok: false, code: "BUDGET_EXHAUSTED", message: guard.message };
    const r = await call();
    await recordUsage({
      workspaceId: this.ctx.workspaceId,
      provider: this.name,
      model: r.ok ? r.model : (r.model ?? this.model),
      purpose,
      requestId: r.ok ? r.requestId : null,
      usage: r.usage,
      ok: r.ok,
      error: r.ok ? null : `${r.code}: ${r.message}`,
    });
    return r;
  }

  compileWorkflow(req: CompileRequest) {
    return this.metered(req.repair ? "compile.repair" : "compile", () => this.inner.compileWorkflow(req));
  }
  patchWorkflow(req: PatchRequest) {
    return this.metered(req.repair ? "patch.repair" : "patch", () => this.inner.patchWorkflow(req));
  }
}
