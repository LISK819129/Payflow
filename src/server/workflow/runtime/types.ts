import type { Tx } from "../../db/client";
import type { approvals, runSteps, workflowRuns, workflows } from "../../db/schema";
import type { GraphNode } from "../dsl/nodes";

export type RunRow = typeof workflowRuns.$inferSelect;
export type StepRow = typeof runSteps.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

/** What expressions and executors can read. Built from persisted state only. */
export type RunContext = {
  trigger: Record<string, unknown>;
  nodes: Record<string, { output: unknown; port: string | null }>;
  workflow: { id: string; name: string };
};

export type EndOutcome = "completed" | "blocked" | "rejected" | "needs_review";

export type NodeResult =
  | { kind: "next"; port: string; output?: unknown; explanation: string }
  | { kind: "wait"; waitFor: "approval" | "timer"; wakeAt?: Date; output?: unknown; explanation: string }
  | {
      kind: "end";
      outcome: EndOutcome;
      explanation: string;
      /** Overrides the path-derived outcome text (e.g. a decision made at an action node). */
      headline?: string;
      /** Marks the ending node's step as an error (e.g. an authority DENY). */
      stepError?: { code: string; message: string };
    }
  | { kind: "error"; code: string; message: string; explanation: string; debugId?: string | null };

export type ExecutorArgs = {
  tx: Tx;
  node: GraphNode;
  ctx: RunContext;
  run: RunRow;
  workflow: WorkflowRow;
  /** The step row if this node already ran and is waiting (approval, timer). */
  waiting: StepRow | null;
  now: Date;
};

export type Executor = (args: ExecutorArgs) => Promise<NodeResult>;

/** Runs a prepared PayPal action. Live: the PayPal action runner. Test/Observe: an adapter with no PayPal access. */
export type ActionsPort = { execute(executionId: string): Promise<"settled" | "busy" | "retry_later" | "halted" | "simulated"> };
/** Runs a pending AI analysis outside the step transaction. "stop": the caller must end this advance (sandbox). */
export type AnalysisPort = { run(analysisId: string): Promise<"done" | "busy" | "stop"> };

/** Side effects the engine needs from the outside world, injectable for tests. */
export type RuntimeDeps = {
  enqueueAdvance(runId: string, opts?: { startAfter?: Date }): Promise<void>;
  now(): Date;
  /** How each step's transaction is opened. Default: a new database transaction. A sandbox passes savepoints of one transaction it always rolls back. */
  transaction?: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Default: live PayPal action runner (which cannot obtain its write capability inside a sandbox). */
  actions?: ActionsPort;
  /** Default: live analysis runner. */
  analysis?: AnalysisPort;
};
