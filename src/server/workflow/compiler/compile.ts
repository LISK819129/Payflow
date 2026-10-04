import { and, desc, eq } from "drizzle-orm";
import type { AIProvider, CompileEnvelope, PatchEnvelope } from "../../ai/types";
import { appendAudit, audit } from "../../audit/audit";
import { db } from "../../db/client";
import { aiCompilations, workflowVersions, workflows } from "../../db/schema";
import { diffGraphs, describeChange, type GraphChange } from "../diff";
import type { WorkflowGraph } from "../dsl/nodes";
import { validateGraph, type Issue } from "../dsl/validate";
import { createWorkflow, saveDraft } from "../service";
import { weakenedControls, type ControlChange } from "./assess";
import { reviewBoundaries } from "./boundaries";
import { refreshLabels, type StaleMention } from "./labels";
import { graphForModel, wireToGraph } from "./convert";
import { checkGrounding, type Ungrounded } from "./grounding";
import { systemPrompt } from "./prompt";
import { sha256Hex } from "../../audit/canonical";
import { applyOps } from "./ops";

/** Initial attempt plus at most one repair; never more (each attempt is a paid call). */
const MAX_ATTEMPTS = 2;

export type Interpretation = Pick<CompileEnvelope, "interpretation" | "assumptions" | "questions" | "unsupported">;

export type CompileOutcome =
  | { status: "COMPILED"; compilationId: string; workflowId: string; graph: WorkflowGraph; ai: Interpretation; validation: Issue[]; activationIssues: Issue[]; attempts: number; corrections: string[] }
  | { status: "NEEDS_CLARIFICATION"; compilationId: string; ai: Interpretation; questions: { topic: string; question: string }[]; ungrounded: Ungrounded[]; graph?: WorkflowGraph; attempts: number }
  | { status: "UNSUPPORTED"; compilationId: string; ai: Interpretation; attempts: number }
  | { status: "INVALID"; compilationId: string; ai?: Interpretation; problems: string[]; graph?: WorkflowGraph; attempts: number }
  | { status: "FAILED"; compilationId?: string; error: string; attempts: number };

export type PatchOutcome =
  | {
      status: "PROPOSED";
      compilationId: string;
      ai: Interpretation;
      before: WorkflowGraph;
      graph: WorkflowGraph;
      changes: GraphChange[];
      weakened: ControlChange[];
      validation: Issue[];
      attempts: number;
      corrections: string[];
      staleMentions: StaleMention[];
    }
  | { status: "NEEDS_CLARIFICATION"; compilationId: string; ai: Interpretation; questions: { topic: string; question: string }[]; ungrounded: Ungrounded[]; attempts: number }
  | { status: "UNSUPPORTED"; compilationId: string; ai: Interpretation; attempts: number }
  | { status: "INVALID"; compilationId: string; ai?: Interpretation; problems: string[]; attempts: number }
  | { status: "FAILED"; compilationId?: string; error: string; attempts: number };

const interp = (e: CompileEnvelope | PatchEnvelope): Interpretation => ({
  interpretation: e.interpretation,
  assumptions: e.assumptions,
  questions: e.questions,
  unsupported: e.unsupported,
});

export function checkInstruction(instruction: string): string | null {
  const t = instruction.trim();
  if (t.length < 8) return "Describe what the workflow should do in a sentence or more.";
  if (t.length > 4000) return "Keep the instruction under 4,000 characters.";
  return null;
}

const errorsOf = (issues: Issue[]) => issues.filter((i) => i.severity === "error");

/**
 * Natural language → validated DRAFT workflow. The model proposes; PayFlow's
 * validator and grounding check decide. A draft is created only when the graph
 * validates and every critical value is grounded in the instruction. Nothing
 * here can activate a workflow.
 */
export async function compileInstruction(input: { workspaceId: string; userId: string; instruction: string; provider: AIProvider }): Promise<CompileOutcome> {
  const instruction = input.instruction.trim();
  const bad = checkInstruction(instruction);
  if (bad) return { status: "FAILED", error: bad, attempts: 0 };

  let repair: { previousOutput: string; problems: string[] } | undefined;
  const repairs: string[][] = [];
  let last: { env?: CompileEnvelope; raw?: string; problems: string[]; graph?: WorkflowGraph } = { problems: [] };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await input.provider.compileWorkflow({ instruction, repair });
    if (!r.ok) {
      if (r.code === "MALFORMED_OUTPUT" && attempt < MAX_ATTEMPTS && r.raw) {
        repair = { previousOutput: r.raw.slice(0, 8000), problems: [r.message] };
        repairs.push(repair.problems);
        continue;
      }
      const id = await record(input, { kind: "COMPILE", status: "FAILED", provider: input.provider, error: { code: r.code, message: r.message }, output: r.raw ? { raw: r.raw.slice(0, 8000) } : null, attempts: attempt, repairs });
      return { status: "FAILED", compilationId: id, error: r.message, attempts: attempt };
    }

    const env = r.value;
    if (env.status === "needs_clarification") {
      const id = await record(input, { kind: "COMPILE", status: "NEEDS_CLARIFICATION", provider: input.provider, output: env, attempts: attempt, repairs });
      return { status: "NEEDS_CLARIFICATION", compilationId: id, ai: interp(env), questions: env.questions, ungrounded: [], attempts: attempt };
    }
    if (env.status === "unsupported") {
      const id = await record(input, { kind: "COMPILE", status: "UNSUPPORTED", provider: input.provider, output: env, attempts: attempt, repairs });
      return { status: "UNSUPPORTED", compilationId: id, ai: interp(env), attempts: attempt };
    }

    const { graph, problems } = wireToGraph(env.workflow.nodes, env.workflow.edges);
    const v = validateGraph(graph);
    const all = [...problems, ...errorsOf(v.issues).map((i) => i.message)];
    last = { env, raw: r.raw, problems: all, graph: v.graph ?? graph };
    if (all.length > 0) {
      if (attempt < MAX_ATTEMPTS) {
        repair = { previousOutput: r.raw.slice(0, 8000), problems: all };
        repairs.push(all);
        continue;
      }
      break;
    }

    // Validated. Exact boundaries next: "under $X" vs "up to $X" must land X on the stated side.
    const bounded = structuredClone(v.graph!);
    const boundaries = reviewBoundaries(bounded, instruction);
    if (boundaries.questions.length > 0) {
      const id = await record(input, { kind: "COMPILE", status: "NEEDS_CLARIFICATION", provider: input.provider, output: env, graph: v.graph, attempts: attempt, repairs });
      return { status: "NEEDS_CLARIFICATION", compilationId: id, ai: interp(env), questions: [...env.questions, ...boundaries.questions], ungrounded: [], graph: v.graph, attempts: attempt };
    }
    const corrections = boundaries.corrections.map((c) => c.message);
    if (corrections.length > 0) {
      const again = validateGraph(bounded);
      if (!again.ok) throw new Error("boundary correction produced an invalid graph"); // cannot happen: only operators change
      v.graph!.nodes = again.graph!.nodes;
    }

    // Did the model invent any critical value?
    const ungrounded = checkGrounding(v.graph!, [instruction]);
    if (ungrounded.length > 0) {
      const id = await record(input, { kind: "COMPILE", status: "NEEDS_CLARIFICATION", provider: input.provider, output: env, graph: v.graph, grounding: ungrounded, attempts: attempt, repairs });
      return {
        status: "NEEDS_CLARIFICATION",
        compilationId: id,
        ai: interp(env),
        questions: [...env.questions, ...ungrounded.map((u) => ({ topic: u.field, question: u.question }))],
        ungrounded,
        graph: v.graph,
        attempts: attempt,
      };
    }

    const activation = validateGraph(v.graph, { forActivation: true });
    const compileMeta = {
      provider: input.provider.name,
      model: r.model,
      requestId: r.requestId ?? null,
      generatedAt: new Date().toISOString(),
      instruction,
      attempts: attempt,
      repairReasons: repairs,
      boundaryCorrections: corrections,
      /** Identifies the exact system prompt version that produced this workflow. */
      promptHash: sha256Hex(systemPrompt()).slice(0, 16),
      interpretation: env.interpretation,
      assumptions: env.assumptions,
      unsupported: env.unsupported,
    };
    const created = await createWorkflow({
      workspaceId: input.workspaceId,
      userId: input.userId,
      name: env.workflow.name.trim() || "AI-compiled workflow",
      description: env.workflow.description,
      graph: v.graph!,
      provenance: "AI_GENERATED",
      compileMeta,
    });
    if (!created.ok) {
      const id = await record(input, { kind: "COMPILE", status: "INVALID", provider: input.provider, output: env, error: { message: created.error }, attempts: attempt, repairs });
      return { status: "INVALID", compilationId: id, ai: interp(env), problems: [created.error], attempts: attempt };
    }
    const id = await record(input, {
      kind: "COMPILE",
      status: "COMPILED",
      provider: input.provider,
      output: env,
      graph: v.graph,
      validation: [...activation.issues, ...boundaries.corrections.map((c) => ({ severity: "warning", code: "boundary_corrected", message: c.message, nodeId: c.nodeId }))],
      grounding: [],
      attempts: attempt,
      repairs,
      workflowId: created.workflowId,
      resultVersionId: created.versionId,
    });
    await db().update(workflowVersions).set({ compileMeta: { ...compileMeta, compilationId: id } }).where(eq(workflowVersions.id, created.versionId));
    return {
      status: "COMPILED",
      compilationId: id,
      workflowId: created.workflowId,
      graph: v.graph!,
      ai: interp(env),
      validation: v.issues,
      activationIssues: activation.issues.filter((i) => i.severity === "error"),
      attempts: attempt,
      corrections,
    };
  }

  const id = await record(input, { kind: "COMPILE", status: "INVALID", provider: input.provider, output: last.env ?? null, graph: last.graph ?? null, error: { problems: last.problems }, attempts: MAX_ATTEMPTS, repairs });
  return { status: "INVALID", compilationId: id, ai: last.env ? interp(last.env) : undefined, problems: last.problems, graph: last.graph, attempts: MAX_ATTEMPTS };
}

/**
 * Natural-language edit → a proposed set of precise changes to the latest
 * version. Nothing is saved until the person confirms with `applyProposal`.
 */
export async function proposePatch(input: { workspaceId: string; userId: string; workflowId: string; instruction: string; provider: AIProvider }): Promise<PatchOutcome> {
  const instruction = input.instruction.trim();
  const bad = checkInstruction(instruction);
  if (bad) return { status: "FAILED", error: bad, attempts: 0 };
  const [wf] = await db()
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, input.workspaceId)));
  if (!wf) return { status: "FAILED", error: "Workflow not found", attempts: 0 };
  const [base] = await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)).orderBy(desc(workflowVersions.version)).limit(1);
  const before = base.graph as WorkflowGraph;
  const baseErrors = new Set(errorsOf(validateGraph(before).issues).map((i) => i.message));
  const ctx = { ...input, workflowId: wf.id, baseVersionId: base.id };

  let repair: { previousOutput: string; problems: string[] } | undefined;
  const repairs: string[][] = [];
  let lastProblems: string[] = [];
  let lastEnv: PatchEnvelope | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await input.provider.patchWorkflow({ instruction, workflowName: wf.name, currentGraph: graphForModel(before), repair });
    if (!r.ok) {
      if (r.code === "MALFORMED_OUTPUT" && attempt < MAX_ATTEMPTS && r.raw) {
        repair = { previousOutput: r.raw.slice(0, 8000), problems: [r.message] };
        repairs.push(repair.problems);
        continue;
      }
      const id = await record(ctx, { kind: "PATCH", status: "FAILED", provider: input.provider, error: { code: r.code, message: r.message }, attempts: attempt, repairs });
      return { status: "FAILED", compilationId: id, error: r.message, attempts: attempt };
    }
    const env = r.value;
    lastEnv = env;
    if (env.status === "needs_clarification") {
      const id = await record(ctx, { kind: "PATCH", status: "NEEDS_CLARIFICATION", provider: input.provider, output: env, attempts: attempt, repairs });
      return { status: "NEEDS_CLARIFICATION", compilationId: id, ai: interp(env), questions: env.questions, ungrounded: [], attempts: attempt };
    }
    if (env.status === "unsupported") {
      const id = await record(ctx, { kind: "PATCH", status: "UNSUPPORTED", provider: input.provider, output: env, attempts: attempt, repairs });
      return { status: "UNSUPPORTED", compilationId: id, ai: interp(env), attempts: attempt };
    }

    const applied = applyOps(before, env.operations);
    // Keep each changed node's own wording consistent with its new values.
    const labelReview = applied.ok ? refreshLabels(before, applied.graph) : { refreshed: [], stale: [] as StaleMention[] };
    let problems: string[] = applied.ok ? [] : applied.problems;
    let after: WorkflowGraph | undefined;
    let issues: Issue[] = [];
    if (applied.ok) {
      const v = validateGraph(applied.graph);
      after = v.graph ?? applied.graph;
      issues = v.issues;
      // Only errors the patch introduced count; a draft may already have had problems.
      problems = errorsOf(v.issues).filter((i) => !baseErrors.has(i.message)).map((i) => i.message);
    }
    lastProblems = problems;
    if (problems.length > 0 || !after) {
      if (attempt < MAX_ATTEMPTS) {
        repair = { previousOutput: r.raw.slice(0, 8000), problems };
        repairs.push(problems);
        continue;
      }
      break;
    }

    const boundaries = reviewBoundaries(after, instruction);
    if (boundaries.questions.length > 0) {
      const id = await record(ctx, { kind: "PATCH", status: "NEEDS_CLARIFICATION", provider: input.provider, output: env, graph: after, attempts: attempt, repairs });
      return { status: "NEEDS_CLARIFICATION", compilationId: id, ai: interp(env), questions: [...env.questions, ...boundaries.questions], ungrounded: [], attempts: attempt };
    }
    const corrections = boundaries.corrections.map((c) => c.message);

    const ungrounded = checkGrounding(after, [instruction, JSON.stringify(before.nodes.map((n) => n.config))]);
    if (ungrounded.length > 0) {
      const id = await record(ctx, { kind: "PATCH", status: "NEEDS_CLARIFICATION", provider: input.provider, output: env, graph: after, grounding: ungrounded, attempts: attempt, repairs });
      return {
        status: "NEEDS_CLARIFICATION",
        compilationId: id,
        ai: interp(env),
        questions: [...env.questions, ...ungrounded.map((u) => ({ topic: u.field, question: u.question }))],
        ungrounded,
        attempts: attempt,
      };
    }

    const changes = diffGraphs({ ...before, layout: undefined }, { ...after, layout: undefined });
    const weakened = weakenedControls(before, after);
    const id = await record(ctx, {
      kind: "PATCH",
      status: "PROPOSED",
      provider: input.provider,
      output: env,
      graph: after,
      validation: issues,
      grounding: [],
      changes: { changes, weakened, corrections, staleMentions: labelReview.stale, model: r.model, requestId: r.requestId ?? null },
      attempts: attempt,
      repairs,
    });
    return { status: "PROPOSED", compilationId: id, ai: interp(env), before, graph: after, changes, weakened, validation: issues, attempts: attempt, corrections, staleMentions: labelReview.stale };
  }
  const id = await record(ctx, { kind: "PATCH", status: "INVALID", provider: input.provider, output: lastEnv ?? null, error: { problems: lastProblems }, attempts: MAX_ATTEMPTS, repairs });
  return { status: "INVALID", compilationId: id, ai: lastEnv ? interp(lastEnv) : undefined, problems: lastProblems, attempts: MAX_ATTEMPTS };
}

/**
 * The person confirms a proposed edit. It is saved as a new DRAFT version
 * (never activated). Weakening changes require explicit acknowledgement, and a
 * proposal made against an older version is refused.
 */
export async function applyProposal(input: { workspaceId: string; userId: string; compilationId: string; acknowledgeWeakening: boolean }) {
  const [c] = await db()
    .select()
    .from(aiCompilations)
    .where(and(eq(aiCompilations.id, input.compilationId), eq(aiCompilations.workspaceId, input.workspaceId)));
  if (!c || c.kind !== "PATCH" || !c.workflowId) return { ok: false as const, error: "Proposal not found" };
  if (c.status !== "PROPOSED") return { ok: false as const, error: `This proposal is ${c.status.toLowerCase()}` };
  const [latest] = await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, c.workflowId)).orderBy(desc(workflowVersions.version)).limit(1);
  if (latest.id !== c.baseVersionId) return { ok: false as const, error: "The workflow changed after this proposal was made; ask again" };
  const meta = c.changes as { changes: GraphChange[]; weakened: ControlChange[]; model: string; requestId: string | null };
  if (meta.weakened.length > 0 && !input.acknowledgeWeakening) {
    return { ok: false as const, error: "This change weakens controls; confirm that you understand before saving" };
  }
  const graph = { ...(c.graph as WorkflowGraph), layout: (latest.graph as WorkflowGraph).layout };
  const saved = await saveDraft({
    workspaceId: input.workspaceId,
    userId: input.userId,
    workflowId: c.workflowId,
    graph,
    provenance: "AI_GENERATED",
    compileMeta: {
      provider: c.provider,
      model: meta.model,
      requestId: meta.requestId,
      generatedAt: c.createdAt.toISOString(),
      instruction: c.instruction,
      compilationId: c.id,
      kind: "patch",
      changes: meta.changes.map(describeChange),
      weakened: meta.weakened.map((w) => w.message),
    },
  });
  if (!saved.ok) return { ok: false as const, error: saved.error };
  await db().transaction(async (tx) => {
    await tx.update(aiCompilations).set({ status: "APPLIED", resultVersionId: saved.versionId, decidedAt: new Date() }).where(eq(aiCompilations.id, c.id));
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "ai.patch_applied",
      summary: `Confirmed AI edit to draft v${saved.version}: ${meta.changes.map(describeChange).slice(0, 4).join("; ")}`,
      payload: { compilationId: c.id, instruction: c.instruction, changes: meta.changes.map(describeChange), weakened: meta.weakened.map((w) => w.message) },
      workflowId: c.workflowId,
    });
  });
  return { ok: true as const, version: saved.version };
}

export async function discardProposal(input: { workspaceId: string; userId: string; compilationId: string }) {
  await db()
    .update(aiCompilations)
    .set({ status: "DISCARDED", decidedAt: new Date() })
    .where(and(eq(aiCompilations.id, input.compilationId), eq(aiCompilations.workspaceId, input.workspaceId), eq(aiCompilations.status, "PROPOSED")));
}

async function record(
  ctx: { workspaceId: string; userId: string; instruction: string; workflowId?: string; baseVersionId?: string },
  r: {
    kind: "COMPILE" | "PATCH";
    status: (typeof aiCompilations.$inferInsert)["status"];
    provider: AIProvider;
    output?: unknown;
    graph?: unknown;
    validation?: unknown;
    grounding?: unknown;
    changes?: unknown;
    error?: unknown;
    attempts: number;
    repairs?: string[][];
    workflowId?: string;
    resultVersionId?: string;
  },
): Promise<string> {
  const [row] = await db()
    .insert(aiCompilations)
    .values({
      workspaceId: ctx.workspaceId,
      kind: r.kind,
      status: r.status,
      instruction: ctx.instruction.trim(),
      workflowId: r.workflowId ?? ctx.workflowId ?? null,
      baseVersionId: ctx.baseVersionId ?? null,
      resultVersionId: r.resultVersionId ?? null,
      provider: r.provider.name,
      model: r.provider.model,
      output: r.output ?? null,
      graph: r.graph ?? null,
      validation: r.validation ?? null,
      grounding: r.grounding ?? null,
      changes: r.changes ?? null,
      error: r.error ?? null,
      attempts: r.attempts,
      repairs: r.repairs && r.repairs.length ? r.repairs : null,
      createdBy: ctx.userId,
    })
    .returning({ id: aiCompilations.id });
  await audit({
    workspaceId: ctx.workspaceId,
    actor: `ai:${r.provider.model}`,
    kind: `ai.${r.kind === "COMPILE" ? "compile" : "patch"}.${r.status.toLowerCase()}`,
    summary: `AI ${r.kind === "COMPILE" ? "compilation" : "edit"} ${r.status.toLowerCase().replace("_", " ")}: "${ctx.instruction.trim().slice(0, 90)}${ctx.instruction.length > 90 ? "…" : ""}"`,
    payload: { compilationId: row.id, provider: r.provider.name, model: r.provider.model, attempts: r.attempts },
    workflowId: r.workflowId ?? ctx.workflowId ?? null,
  });
  return row.id;
}

/**
 * Rebuilds the outcome of a past compilation from its stored record, without
 * calling any model: used to review (and evidence) what a real call produced.
 */
export async function storedCompileOutcome(workspaceId: string, compilationId: string): Promise<{ instruction: string; createdAt: Date; model: string; outcome: CompileOutcome } | null> {
  const [c] = await db()
    .select()
    .from(aiCompilations)
    .where(and(eq(aiCompilations.id, compilationId), eq(aiCompilations.workspaceId, workspaceId), eq(aiCompilations.kind, "COMPILE")));
  if (!c) return null;
  const env = c.output as CompileEnvelope | null;
  const ai = env ? interp(env) : undefined;
  const graph = (c.graph as WorkflowGraph | null) ?? undefined;
  const base = { compilationId: c.id, attempts: c.attempts };
  let outcome: CompileOutcome;
  switch (c.status) {
    case "COMPILED":
      outcome = {
        ...base,
        status: "COMPILED",
        workflowId: c.workflowId!,
        graph: graph!,
        ai: ai!,
        validation: [],
        activationIssues: ((c.validation as Issue[] | null) ?? []).filter((i) => i.severity === "error"),
        corrections: ((c.validation as Issue[] | null) ?? []).filter((i) => i.code === "boundary_corrected").map((i) => i.message),
      };
      break;
    case "NEEDS_CLARIFICATION": {
      const ungrounded = (c.grounding as Ungrounded[] | null) ?? [];
      outcome = { ...base, status: "NEEDS_CLARIFICATION", ai: ai!, ungrounded, graph, questions: [...(env?.questions ?? []), ...ungrounded.map((u) => ({ topic: u.field, question: u.question }))] };
      break;
    }
    case "UNSUPPORTED":
      outcome = { ...base, status: "UNSUPPORTED", ai: ai! };
      break;
    case "INVALID":
      outcome = { ...base, status: "INVALID", ai, graph, problems: ((c.error as { problems?: string[] } | null)?.problems ?? []) };
      break;
    default:
      outcome = { ...base, status: "FAILED", error: ((c.error as { message?: string } | null)?.message ?? "Failed") };
  }
  return { instruction: c.instruction, createdAt: c.createdAt, model: c.model, outcome };
}
