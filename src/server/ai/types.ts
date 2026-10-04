import { z } from "zod";

/**
 * Provider-neutral contract between PayFlow and any language model.
 *
 * The envelopes below are what a model must return. They are deliberately flat
 * (no recursion, every field required) so any provider's structured-output
 * mode can enforce them, and node configs travel as JSON strings that PayFlow
 * parses with its own schemas. Nothing in the workflow engine or the policy
 * layer reads a provider-specific response format.
 */

const short = z.string().max(400);

export const WireNode = z.object({
  id: z.string().max(60),
  type: z.string().max(60),
  label: z.string().max(120),
  /** The node's config object, JSON-encoded. Parsed and validated by PayFlow. */
  config_json: z.string().max(6000),
});
export type WireNode = z.infer<typeof WireNode>;

export const WireEdge = z.object({ from: z.string().max(60), port: z.string().max(40), to: z.string().max(60) });

export const Question = z.object({ topic: z.string().max(80), question: short });
export const Unsupported = z.object({ request: short, reason: short });

export const CompileEnvelope = z.object({
  status: z.enum(["compiled", "needs_clarification", "unsupported"]),
  /** Plain-language restatement of what the user asked for. */
  interpretation: z.string().max(1200),
  /** Non-critical choices the model made (labels, outcome wording, structure). */
  assumptions: z.array(short).max(20),
  questions: z.array(Question).max(10),
  unsupported: z.array(Unsupported).max(10),
  workflow: z.object({
    name: z.string().max(120),
    description: z.string().max(600),
    nodes: z.array(WireNode).max(60),
    edges: z.array(WireEdge).max(150),
  }),
});
export type CompileEnvelope = z.infer<typeof CompileEnvelope>;

/** Patch operations, flattened: fields that don't apply to an op are empty strings. */
export const WireOp = z.object({
  op: z.enum(["set_config", "set_label", "add_node", "remove_node", "connect", "disconnect"]),
  node_id: z.string().max(60),
  /** Dotted path inside the node's config, for set_config (e.g. "max.value"). */
  path: z.string().max(120),
  /** JSON-encoded value for set_config. */
  value_json: z.string().max(6000),
  label: z.string().max(120),
  node: WireNode,
  from: z.string().max(60),
  port: z.string().max(40),
  to: z.string().max(60),
});
export type WireOp = z.infer<typeof WireOp>;

export const PatchEnvelope = z.object({
  status: z.enum(["patched", "needs_clarification", "unsupported"]),
  interpretation: z.string().max(1200),
  assumptions: z.array(short).max(20),
  questions: z.array(Question).max(10),
  unsupported: z.array(Unsupported).max(10),
  operations: z.array(WireOp).max(40),
});
export type PatchEnvelope = z.infer<typeof PatchEnvelope>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export type AIErrorCode = "NOT_CONFIGURED" | "BUDGET_EXHAUSTED" | "MALFORMED_OUTPUT" | "REFUSED" | "TRUNCATED" | "PROVIDER_ERROR" | "RATE_LIMITED";

export type AIResult<T> =
  | { ok: true; value: T; usage: Usage; model: string; requestId?: string; raw: string }
  | { ok: false; code: AIErrorCode; message: string; usage?: Usage; model?: string; raw?: string };

export type CompileRequest = {
  instruction: string;
  /** Set on a repair attempt: the previous output and PayFlow's objections to it. */
  repair?: { previousOutput: string; problems: string[] };
};

export type PatchRequest = {
  instruction: string;
  /** The current graph, as the model should see it. */
  currentGraph: unknown;
  workflowName: string;
  repair?: { previousOutput: string; problems: string[] };
};

/**
 * One execution-time analysis (Phase 7): fixed instructions, an input message in
 * which untrusted documents are fenced as data, and a PayFlow-owned schema the
 * answer must match. No tools are ever offered to the model.
 */
export type AnalysisRequest<T> = {
  task: string;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
};

/**
 * A language-model provider. Implementations call a model and return a value
 * that parses as the envelope; PayFlow re-parses it anyway.
 */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  compileWorkflow(req: CompileRequest): Promise<AIResult<CompileEnvelope>>;
  patchWorkflow(req: PatchRequest): Promise<AIResult<PatchEnvelope>>;
  analyze<T>(req: AnalysisRequest<T>): Promise<AIResult<T>>;
}
