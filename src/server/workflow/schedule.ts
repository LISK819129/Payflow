import { QUEUES, boss } from "../jobs/boss";
import type { WorkflowGraph } from "./dsl/nodes";
import { startRun } from "./runtime/engine";
import type { RuntimeDeps } from "./runtime/types";

/** After activation: register (or remove) the cron schedule for a workflow's trigger. */
export async function syncSchedule(workflowId: string, graph: WorkflowGraph) {
  const b = await boss();
  const t = graph.nodes.find((n) => n.type === "trigger.schedule");
  if (t) {
    await b.schedule(QUEUES.workflowSchedule, t.config.cron as string, { workflowId }, { key: workflowId, tz: (t.config.timezone as string) ?? "UTC" });
  } else {
    await b.unschedule(QUEUES.workflowSchedule, workflowId).catch(() => {});
  }
}

/**
 * A schedule fired. The run is keyed by the minute it fired for, so a duplicate
 * delivery of the same tick cannot start a second run; a paused or frozen
 * workflow is skipped by startRun.
 */
export async function onScheduleTick(workflowId: string, deps: RuntimeDeps) {
  const slot = new Date(Math.floor(deps.now().getTime() / 60_000) * 60_000).toISOString();
  return startRun(
    { workflowId, triggerKind: "schedule", triggerRef: `schedule:${slot}`, triggerPayload: { kind: "schedule", firedAt: slot }, provenance: "USER_PROVIDED" },
    deps,
  );
}
