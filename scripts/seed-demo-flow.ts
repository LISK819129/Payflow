/**
 * Seeds a hand-built (USER_PROVIDED) Nova Labs client-payment flow using only
 * nodes that run in Phase 3. It is created as a DRAFT: activation stays a human
 * action in the Flow Builder. Phase 4 replaces this with the AI-compiled flow.
 *
 *   pnpm db:seed:demo-flow
 */
import "./load-env";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import type { WorkflowGraph } from "../src/server/workflow/dsl/nodes";
import { createWorkflow } from "../src/server/workflow/service";
import { merchantWorkspaceId } from "../src/server/workspace";

const NOVA = ["accounts@novalabs.example"];

const graph: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "payment", type: "trigger.paypal_event", label: "Nova payment received", config: { eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] } },
    { id: "is_nova", type: "policy.counterparty", label: "Payer is Nova Labs", config: { ref: "trigger.payer.email", allowed: NOVA } },
    { id: "usd", type: "policy.currency", label: "Paid in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    {
      id: "normal",
      type: "control.condition",
      label: "Within 10% of usual $4,000",
      config: { expr: { op: "pct_diff", left: { ref: "trigger.amount.value" }, right: { const: "4000" }, cmp: "lte", pct: 10 } },
    },
    { id: "review_amount", type: "control.approval", label: "Amount differs materially", config: { reason: "Nova's payment differs from the usual ~$4,000 by more than 10%", amountRef: "trigger.amount", counterpartyRef: "trigger.payer.email" } },
    { id: "review_currency", type: "control.approval", label: "Currency changed", config: { reason: "Nova paid in a currency other than USD", amountRef: "trigger.amount", counterpartyRef: "trigger.payer.email" } },
    { id: "accepted", type: "control.terminal", label: "Accepted", config: { outcome: "completed", message: "Normal Nova payment accepted" } },
    { id: "accepted_after_review", type: "control.terminal", label: "Accepted after review", config: { outcome: "completed", message: "Accepted after human review" } },
    { id: "rejected", type: "control.terminal", label: "Rejected", config: { outcome: "rejected", message: "Rejected after human review" } },
    { id: "not_nova", type: "control.terminal", label: "Not Nova", config: { outcome: "needs_review", message: "Payment is not from Nova Labs; left for manual review" } },
  ],
  edges: [
    { from: "payment", to: "is_nova", port: "next" },
    { from: "is_nova", to: "usd", port: "pass" },
    { from: "is_nova", to: "not_nova", port: "block" },
    { from: "usd", to: "normal", port: "pass" },
    { from: "usd", to: "review_currency", port: "block" },
    { from: "normal", to: "accepted", port: "true" },
    { from: "normal", to: "review_amount", port: "false" },
    { from: "normal", to: "review_amount", port: "error" },
    { from: "review_amount", to: "accepted_after_review", port: "approved" },
    { from: "review_amount", to: "rejected", port: "rejected" },
    { from: "review_currency", to: "accepted_after_review", port: "approved" },
    { from: "review_currency", to: "rejected", port: "rejected" },
  ],
};

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(eq(users.workspaceId, workspaceId)).limit(1);
  const r = await createWorkflow({ workspaceId, userId: owner.id, name: "Nova Labs — client payments", graph });
  console.log(r.ok ? `Created draft ${r.workflowId}` : r);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
