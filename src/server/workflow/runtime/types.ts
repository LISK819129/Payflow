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
  | { kind: "end"; outcome: EndOutcome; explanation: string }
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

/** Side effects the engine needs from the outside world, injectable for tests. */
export type RuntimeDeps = {
  enqueueAdvance(runId: string, opts?: { startAfter?: Date }): Promise<void>;
  now(): Date;
};
