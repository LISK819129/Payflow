import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CompileEnvelope, PatchEnvelope } from "@/server/ai/types";
import { closeDb, db } from "@/server/db/client";
import { runSteps, workflowRuns } from "@/server/db/schema";
import { reviewBoundaries, statedBoundaries } from "@/server/workflow/compiler/boundaries";
import { compileInstruction, proposePatch } from "@/server/workflow/compiler/compile";
import { refreshLabels } from "@/server/workflow/compiler/labels";
import { applyOps } from "@/server/workflow/compiler/ops";
import { wireToGraph } from "@/server/workflow/compiler/convert";
import { toScaled } from "@/server/workflow/dsl/decimal";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { advanceRun, decideApproval, startRun } from "@/server/workflow/runtime/engine";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { activateLatest, createWorkflow } from "@/server/workflow/service";
import realCompile from "./fixtures/real-openai/simple-compile.json";
import realModify from "./fixtures/real-openai/modify-patch.json";
import { createUser, createWorkspace, resetTestDb } from "./support/db";
import { ScriptedProvider } from "./support/mock-ai";

const deps: RuntimeDeps = { enqueueAdvance: async () => {}, now: () => new Date("2026-10-04T10:00:00Z") };
let ws: { id: string };
let user: { id: string };
beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("PixelForge");
  user = await createUser(ws.id);
});
afterAll(closeDb);

const sideOf = (text: string, value: string) => statedBoundaries(text).filter((b) => b.value === toScaled(value)).map((b) => b.side);

describe("4.1 boundary language", () => {
  it.each([
    ["accept it if it's under $2,500", "2500", "HIGH"],
    ["anything below $2,500 is fine", "2500", "HIGH"],
    ["less than $2,500", "2500", "HIGH"],
    ["$2,500 or more needs approval", "2500", "HIGH"],
    ["$2,500 or above", "2500", "HIGH"],
    ["at least $2,500", "2500", "HIGH"],
    ["up to $500 automatically", "500", "LOW"],
    ["at most $500", "500", "LOW"],
    ["no more than $500", "500", "LOW"],
    ["not exceeding $500", "500", "LOW"],
    ["$500 or less", "500", "LOW"],
    ["over $400, ask me", "400", "LOW"],
    ["more than $400", "400", "LOW"],
    ["above $4k", "4000", "LOW"],
  ])("%s → exactly %s is on the %s side", (text, value, side) => {
    expect(sideOf(text, value)).toEqual([side]);
  });
});

const amountLimitGraph = (comparison?: "lt" | "lte"): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: [
    { id: "t", type: "trigger.manual", config: {} },
    { id: "lim", type: "policy.amount_limit", label: "Limit", config: { amountRef: "trigger.amount", max: { value: "2500.00", currency: "USD" }, ...(comparison ? { comparison } : {}) } },
    { id: "ok", type: "control.terminal", config: { outcome: "completed", message: "ok" } },
    { id: "no", type: "control.terminal", config: { outcome: "blocked", message: "no" } },
  ],
  edges: [
    { from: "t", to: "lim", port: "next" },
    { from: "lim", to: "ok", port: "pass" },
    { from: "lim", to: "no", port: "block" },
  ],
});

async function runWith(graph: WorkflowGraph, value: string) {
  const c = await createWorkflow({ workspaceId: ws.id, userId: user.id, name: `g-${Math.random()}`, graph });
  if (!c.ok) throw new Error("setup");
  await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId });
  const r = await startRun({ workflowId: c.workflowId, triggerKind: "manual", triggerRef: `m-${value}-${Math.random()}`, triggerPayload: { amount: { value, currency_code: "USD" } }, provenance: "USER_PROVIDED" }, deps);
  return advanceRun((r as { runId: string }).runId, deps);
}

describe("4.1 exact boundary values in the runtime", () => {
  it("'lt' blocks exactly the limit and passes one cent below", async () => {
    expect(await runWith(amountLimitGraph("lt"), "2500.00")).toBe("BLOCKED");
    expect(await runWith(amountLimitGraph("lt"), "2499.99")).toBe("COMPLETED");
  });
  it("'lte' (default, unchanged for existing graphs) passes exactly the limit and blocks one cent above", async () => {
    expect(await runWith(amountLimitGraph(), "2500.00")).toBe("COMPLETED");
    expect(await runWith(amountLimitGraph("lte"), "2500.01")).toBe("BLOCKED");
  });
});

describe("4.1 boundary review of AI graphs", () => {
  it("corrects an inclusive limit when the instruction says 'under' (unanimous)", () => {
    const g = amountLimitGraph();
    const r = reviewBoundaries(g, "Accept it if it's under $2,500. $2,500 or more, ask me.");
    expect(r.questions).toEqual([]);
    expect(r.corrections).toHaveLength(1);
    expect(g.nodes[1].config.comparison).toBe("lt");
  });

  it("leaves a correct graph alone", () => {
    const g = amountLimitGraph();
    expect(reviewBoundaries(g, "Pay up to $2,500 automatically.")).toEqual({ corrections: [], questions: [] });
    expect(g.nodes[1].config.comparison).toBeUndefined();
  });

  it("corrects conditions in both directions", () => {
    const g: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [{ id: "c", type: "control.condition", label: "Big?", config: { expr: { op: "gt", left: { ref: "trigger.amount" }, right: { const: "400" } } } }],
      edges: [],
    };
    reviewBoundaries(g, "Ask me if it's $400 or more.");
    expect((g.nodes[0].config.expr as { op: string }).op).toBe("gte");
    reviewBoundaries(g, "Ask me if it's over $400.");
    expect((g.nodes[0].config.expr as { op: string }).op).toBe("gt");
  });

  it("asks instead of guessing when the instruction contradicts itself about the exact amount", () => {
    const r = reviewBoundaries(amountLimitGraph(), "Accept anything up to $2,500, but ask me if it's $2,500 or more.");
    expect(r.questions).toHaveLength(1);
    expect(r.corrections).toEqual([]);
  });

  it("REAL_OPENAI regression: the recorded $2,500 compile now holds exactly $2,500 for approval", async () => {
    const p = new ScriptedProvider().onCompile({ kind: "ok", value: realCompile.output as CompileEnvelope });
    const r = await compileInstruction({ workspaceId: ws.id, userId: user.id, instruction: realCompile.instruction, provider: p });
    expect(r.status).toBe("COMPILED");
    if (r.status !== "COMPILED") return;
    expect(r.corrections).toEqual(['"Under $2,500?": exactly $2,500 now goes with the larger amounts, as "under $2,500" says']);
    expect(r.graph.nodes.find((n) => n.id === "under_limit")?.config.comparison).toBe("lt");

    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: r.workflowId });
    const at = await startRun({ workflowId: r.workflowId, triggerKind: "paypal_event", triggerRef: "WH-2500", triggerPayload: { amount: { value: "2500.00", currency_code: "USD" } }, provenance: "SIMULATED" }, deps);
    const below = await startRun({ workflowId: r.workflowId, triggerKind: "paypal_event", triggerRef: "WH-2499", triggerPayload: { amount: { value: "2499.99", currency_code: "USD" } }, provenance: "SIMULATED" }, deps);
    expect(await advanceRun((at as { runId: string }).runId, deps)).toBe("WAITING_APPROVAL");
    expect(await advanceRun((below as { runId: string }).runId, deps)).toBe("COMPLETED");
  });
});

describe("4.1 outcome text follows the path", () => {
  it("REAL_OPENAI regression: an approved run never ends 'Accepted automatically.'", async () => {
    const p = new ScriptedProvider().onCompile({ kind: "ok", value: realCompile.output as CompileEnvelope });
    const r = await compileInstruction({ workspaceId: ws.id, userId: user.id, instruction: realCompile.instruction, provider: p });
    if (r.status !== "COMPILED") throw new Error(r.status);
    await activateLatest({ workspaceId: ws.id, userId: user.id, workflowId: r.workflowId });

    const auto = await startRun({ workflowId: r.workflowId, triggerKind: "paypal_event", triggerRef: "WH-auto", triggerPayload: { amount: { value: "120.00", currency_code: "USD" } }, provenance: "SIMULATED" }, deps);
    await advanceRun((auto as { runId: string }).runId, deps);
    const [autoRun] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, (auto as { runId: string }).runId));
    expect(autoRun.outcome).toBe("Completed automatically");

    const big = await startRun({ workflowId: r.workflowId, triggerKind: "paypal_event", triggerRef: "WH-big", triggerPayload: { amount: { value: "2750.00", currency_code: "USD" } }, provenance: "SIMULATED" }, deps);
    const runId = (big as { runId: string }).runId;
    await advanceRun(runId, deps);
    const { approvals } = await import("@/server/db/schema");
    const [a] = await db().select().from(approvals).where(eq(approvals.runId, runId));
    await decideApproval({ approvalId: a.id, workspaceId: ws.id, userId: user.id, decision: "APPROVED" }, deps);
    expect(await advanceRun(runId, deps)).toBe("COMPLETED");
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.outcome).toBe("Completed after approval at “Ask me”");
    expect(run.outcome).not.toMatch(/automatically/i);
    const steps = await db().select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
    expect(steps.at(-1)?.output).toEqual({ endNote: "Accepted automatically." }); // authored copy kept only as a note
  });
});

describe("4.1 labels follow edited values", () => {
  const simpleGraph = () => {
    const { graph } = wireToGraph(realCompile.output.workflow.nodes, realCompile.output.workflow.edges);
    return graph;
  };

  it("REAL_OPENAI regression: the recorded $2,500 → $1,800 edit relabels its node and flags other stale text", () => {
    const before = simpleGraph();
    const applied = applyOps(before, (realModify.output as PatchEnvelope).operations);
    if (!applied.ok) throw new Error(applied.problems.join());
    const { refreshed, stale } = refreshLabels(before, applied.graph);
    expect(applied.graph.nodes.find((n) => n.id === "under_limit")?.label).toBe("Under $1,800?");
    expect(refreshed).toEqual([{ nodeId: "under_limit", field: "label", before: "Under $2,500?", after: "Under $1,800?" }]);
    expect(stale.map((s) => s.nodeId)).toEqual(["owner_approval"]); // its reason still says $2,500: shown to the person
  });

  it("keeps the writer's style and leaves text the edit already changed", () => {
    const before: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [{ id: "l", type: "policy.amount_limit", label: "Up to 2500.00 USD", config: { amountRef: "trigger.amount", max: { value: "2500.00", currency: "USD" } } }],
      edges: [],
    };
    const after = structuredClone(before);
    after.nodes[0].config.max = { value: "1800.00", currency: "USD" };
    refreshLabels(before, after);
    expect(after.nodes[0].label).toBe("Up to 1800.00 USD");

    const edited = structuredClone(before);
    edited.nodes[0].config.max = { value: "1800.00", currency: "USD" };
    edited.nodes[0].label = "New cap";
    refreshLabels(before, edited);
    expect(edited.nodes[0].label).toBe("New cap");
  });

  it("an AI edit proposal shows the label change in its diff", async () => {
    const p = new ScriptedProvider().onCompile({ kind: "ok", value: realCompile.output as CompileEnvelope }).onPatch({ kind: "ok", value: realModify.output as PatchEnvelope });
    const c = await compileInstruction({ workspaceId: ws.id, userId: user.id, instruction: realCompile.instruction, provider: p });
    if (c.status !== "COMPILED") throw new Error(c.status);
    const r = await proposePatch({ workspaceId: ws.id, userId: user.id, workflowId: c.workflowId, instruction: realModify.instruction, provider: p });
    expect(r.status).toBe("PROPOSED");
    if (r.status !== "PROPOSED") return;
    expect(r.changes).toContainEqual({ kind: "label_changed", nodeId: "under_limit", title: "Under $1,800?", before: "Under $2,500?", after: "Under $1,800?" });
    expect(r.staleMentions.map((s) => s.nodeId)).toEqual(["owner_approval"]);
  });
});
