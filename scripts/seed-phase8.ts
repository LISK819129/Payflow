/**
 * Phase 8 demo state (no AI used to build it): a DRAFT workflow that listens
 * for BILLING.PLAN.CREATED, for proving Observe Mode on a real Sandbox event
 * that moves no money (`pnpm paypal:sandbox:plan` produces one). Observing is
 * switched on by a person in the Flow Builder; this script never activates it.
 *
 *   pnpm db:seed:phase8
 */
import "./load-env";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users, workflows } from "../src/server/db/schema";
import type { WorkflowGraph } from "../src/server/workflow/dsl/nodes";
import { createWorkflow } from "../src/server/workflow/service";
import { merchantWorkspaceId } from "../src/server/workspace";

const NAME = "New subscription plan review";

const graph: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "plan", type: "trigger.paypal_event", label: "New PayPal billing plan", config: { eventTypes: ["BILLING.PLAN.CREATED"] } },
    { id: "review", type: "control.approval", label: "Finance confirms the plan", config: { reason: "A new subscription plan was created in PayPal; finance confirms its price and terms", expiresAfterHours: 72 } },
    { id: "ok", type: "control.terminal", label: "Plan confirmed", config: { outcome: "completed", message: "Finance confirmed the new plan" } },
    { id: "query", type: "control.terminal", label: "Plan queried", config: { outcome: "needs_review", message: "Finance did not confirm the plan; follow up with the plan owner" } },
  ],
  edges: [
    { from: "plan", to: "review", port: "next" },
    { from: "review", to: "ok", port: "approved" },
    { from: "review", to: "query", port: "rejected" },
  ],
};

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(and(eq(users.workspaceId, workspaceId), eq(users.role, "OWNER"))).limit(1);
  const [existing] = await db().select({ id: workflows.id }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.name, NAME)));
  if (existing) {
    console.log(`${NAME} already exists (${existing.id})`);
    return;
  }
  const r = await createWorkflow({ workspaceId, userId: owner.id, name: NAME, description: "Draft: route each new PayPal billing plan to finance for confirmation", graph });
  console.log(JSON.stringify(r));
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
