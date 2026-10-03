import { and, desc, eq } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { canonicalJson, sha256Hex } from "../audit/canonical";
import { db } from "../db/client";
import { workflowRuns, workflowVersions, workflows } from "../db/schema";
import { describeChange, diffGraphs } from "./diff";
import type { WorkflowGraph } from "./dsl/nodes";
import { validateGraph, type Issue } from "./dsl/validate";

export type ServiceError = { ok: false; error: string; issues?: Issue[] };

const hashGraph = (g: WorkflowGraph) => sha256Hex(canonicalJson({ nodes: g.nodes, edges: g.edges }));

/** Layout is presentation only; it never makes a version "different". */
function withoutLayout(g: WorkflowGraph): WorkflowGraph {
  return { schemaVersion: 1, nodes: g.nodes, edges: g.edges };
}

export function starterGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
      { id: "done", type: "control.terminal", label: "Done", config: { outcome: "completed", message: "Workflow finished" } },
    ],
    edges: [{ from: "trigger", to: "done", port: "next" }],
  };
}

export async function createWorkflow(input: {
  workspaceId: string;
  userId: string;
  name: string;
  description?: string;
  graph?: WorkflowGraph;
  provenance?: "USER_PROVIDED" | "AI_GENERATED";
  compileMeta?: Record<string, unknown>;
}) {
  const graph = input.graph ?? starterGraph();
  const shape = validateGraph(graph);
  if (!shape.graph) return { ok: false, error: "Graph is not valid JSON for a workflow", issues: shape.issues } satisfies ServiceError;
  return db().transaction(async (tx) => {
    const [wf] = await tx
      .insert(workflows)
      .values({ workspaceId: input.workspaceId, name: input.name.slice(0, 120), description: input.description ?? null, createdBy: input.userId })
      .returning();
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        workflowId: wf.id,
        version: 1,
        graph: shape.graph!,
        graphHash: hashGraph(shape.graph!),
        provenance: input.provenance ?? "USER_PROVIDED",
        compileMeta: input.compileMeta ?? null,
        validation: { ok: shape.ok, issues: shape.issues },
        createdBy: input.userId,
      })
      .returning();
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "workflow.created",
      summary: `Workflow "${wf.name}" created as a draft${input.provenance === "AI_GENERATED" ? " (AI-generated)" : ""}`,
      payload: { versionId: v.id, graphHash: v.graphHash },
      workflowId: wf.id,
    });
    return { ok: true as const, workflowId: wf.id, versionId: v.id };
  });
}

/**
 * Saves edits. The latest DRAFT version is edited in place; if the latest
 * version is ACTIVE or SUPERSEDED, a new DRAFT version is created, leaving the
 * active version (and every run pinned to it) untouched.
 */
export async function saveDraft(input: {
  workspaceId: string;
  userId: string;
  workflowId: string;
  graph: unknown;
  provenance?: "USER_PROVIDED" | "AI_GENERATED";
  compileMeta?: Record<string, unknown>;
}) {
  const result = validateGraph(input.graph);
  if (!result.graph) return { ok: false, error: "Graph is not valid JSON for a workflow", issues: result.issues } satisfies ServiceError;
  const graph = result.graph;

  return db().transaction(async (tx) => {
    const [wf] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, input.workspaceId)))
      .for("update");
    if (!wf) return { ok: false as const, error: "Workflow not found" };
    const [latest] = await tx
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(desc(workflowVersions.version))
      .limit(1);

    const values = {
      graph,
      graphHash: hashGraph(graph),
      validation: { ok: result.ok, issues: result.issues },
      provenance: input.provenance ?? "USER_PROVIDED",
      compileMeta: input.compileMeta ?? null,
      updatedAt: new Date(),
    } as const;

    if (latest.status === "DRAFT") {
      // Layout-only edits don't change meaning; keep provenance as it was.
      const meaningChanged = latest.graphHash !== values.graphHash;
      await tx
        .update(workflowVersions)
        .set(meaningChanged ? values : { graph, updatedAt: values.updatedAt })
        .where(eq(workflowVersions.id, latest.id));
      return { ok: true as const, versionId: latest.id, version: latest.version, validation: result };
    }
    if (latest.graphHash === values.graphHash) {
      // Only the layout moved on an active version: store layout without a new version.
      await tx.update(workflowVersions).set({ graph }).where(eq(workflowVersions.id, latest.id));
      return { ok: true as const, versionId: latest.id, version: latest.version, validation: result };
    }
    const [v] = await tx
      .insert(workflowVersions)
      .values({ workflowId: wf.id, version: latest.version + 1, createdBy: input.userId, ...values })
      .returning();
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "workflow.version_drafted",
      summary: `Draft v${v.version} of "${wf.name}" created; v${latest.version} stays in effect until the draft is activated`,
      payload: { versionId: v.id, changes: diffGraphs(latest.graph as WorkflowGraph, graph).map(describeChange) },
      workflowId: wf.id,
    });
    return { ok: true as const, versionId: v.id, version: v.version, validation: result };
  });
}

/**
 * Human activation of the latest draft. Full validation (including "every node
 * has an executor") must pass. The previous ACTIVE version is superseded; runs
 * already started on it continue on it.
 */
export async function activateLatest(input: { workspaceId: string; userId: string; workflowId: string }) {
  return db().transaction(async (tx) => {
    const [wf] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, input.workspaceId)))
      .for("update");
    if (!wf) return { ok: false as const, error: "Workflow not found" };
    if (wf.state === "FROZEN") return { ok: false as const, error: "Workflow is frozen; review and unfreeze it first" };
    const [latest] = await tx
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(desc(workflowVersions.version))
      .limit(1);
    if (latest.status !== "DRAFT") return { ok: false as const, error: `v${latest.version} is already ${latest.status.toLowerCase()}` };

    const v = validateGraph(latest.graph, { forActivation: true });
    if (!v.ok) return { ok: false as const, error: "The workflow has problems that must be fixed before activation", issues: v.issues };

    const previous = wf.activeVersionId
      ? (await tx.select().from(workflowVersions).where(eq(workflowVersions.id, wf.activeVersionId)))[0]
      : null;
    if (previous) await tx.update(workflowVersions).set({ status: "SUPERSEDED" }).where(eq(workflowVersions.id, previous.id));
    const now = new Date();
    await tx
      .update(workflowVersions)
      .set({ status: "ACTIVE", activatedBy: input.userId, activatedAt: now, validation: { ok: true, issues: v.issues } })
      .where(eq(workflowVersions.id, latest.id));
    await tx.update(workflows).set({ state: "ACTIVE", activeVersionId: latest.id, updatedAt: now }).where(eq(workflows.id, wf.id));

    const changes = diffGraphs(previous ? withoutLayout(previous.graph as WorkflowGraph) : null, withoutLayout(v.graph));
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "workflow.activated",
      summary: `"${wf.name}" v${latest.version} activated${previous ? ` (replaces v${previous.version})` : ""}`,
      payload: { versionId: latest.id, graphHash: latest.graphHash, provenance: latest.provenance, changes: changes.map(describeChange) },
      workflowId: wf.id,
    });
    return { ok: true as const, versionId: latest.id, version: latest.version, changes };
  });
}

export async function setWorkflowState(input: {
  workspaceId: string;
  userId: string;
  workflowId: string;
  to: "PAUSED" | "ACTIVE";
}) {
  return db().transaction(async (tx) => {
    const [wf] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, input.workspaceId)))
      .for("update");
    if (!wf) return { ok: false as const, error: "Workflow not found" };
    if (input.to === "ACTIVE" && !wf.activeVersionId) return { ok: false as const, error: "Activate a version first" };
    const allowed: Record<string, string[]> = { PAUSED: ["ACTIVE"], ACTIVE: ["PAUSED", "FROZEN"] };
    if (!allowed[input.to].includes(wf.state)) return { ok: false as const, error: `Cannot go from ${wf.state.toLowerCase()} to ${input.to.toLowerCase()}` };
    await tx
      .update(workflows)
      .set({ state: input.to, frozenReason: null, frozenAt: null, frozenByRunId: null, updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));
    const kind = input.to === "PAUSED" ? "workflow.paused" : wf.state === "FROZEN" ? "workflow.unfrozen" : "workflow.resumed";
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind,
      summary: `"${wf.name}" ${kind.split(".")[1]}`,
      payload: wf.state === "FROZEN" ? { previousFreezeReason: wf.frozenReason } : {},
      workflowId: wf.id,
    });
    // Suspended runs are woken by the caller; they re-check the state themselves.
    const suspended = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, wf.id), eq(workflowRuns.status, "SUSPENDED")));
    return { ok: true as const, wake: suspended.map((r) => r.id) };
  });
}
