/**
 * Phase 9 demo state (no AI used to build it): saves v3 of "Cloud procurement"
 * as a DRAFT whose trigger is an Agent request — the same evidence nodes,
 * policy gate and payout as v2, reading the agent's structured request.
 * Activation stays a human action in the Flow Builder; agents are registered
 * by the owner on the Agents page.
 *
 *   pnpm db:seed:phase9
 */
import "./load-env";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users, workflows } from "../src/server/db/schema";
import type { WorkflowGraph } from "../src/server/workflow/dsl/nodes";
import { saveDraft } from "../src/server/workflow/service";
import { merchantWorkspaceId } from "../src/server/workspace";

const graph: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "ask", type: "trigger.agent_request", label: "Agent asks to pay a cloud bill", config: { actions: ["paypal.payout"] } },
    { id: "extract", type: "ai.invoice_extract", label: "Read the invoice", config: { documentRef: "trigger.invoice", amountRef: "trigger.amount" } },
    { id: "purpose", type: "ai.purpose_classification", label: "What is it for?", config: { textRefs: ["trigger.purpose", "trigger.invoice"], amountRef: "trigger.amount", counterpartyRef: "trigger.counterparty", action: "paypal.payout" } },
    {
      id: "behavior",
      type: "ai.behavior_analysis",
      label: "Compare with history",
      config: {
        paymentRef: "trigger.amount",
        counterpartyRef: "trigger.counterparty",
        descriptionRef: "trigger.purpose",
        invoiceNumberRef: "nodes.extract.output.extraction.fields.invoiceNumber.value",
        action: "paypal.payout",
        explain: "when_flagged",
      },
    },
    { id: "contract", type: "ai.contract_match", label: "Check against the contract", config: { invoiceRef: "trigger.invoice", contractRef: "trigger.contract", amountRef: "trigger.amount", counterpartyRef: "trigger.counterparty" } },
    { id: "usd", type: "policy.currency", label: "Bill is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    { id: "pay", type: "paypal.payout", label: "Pay the cloud supplier", config: { receiverRef: "trigger.counterparty", amountRef: "trigger.amount", note: "Payment from PixelForge Studio" } },
    { id: "paid", type: "control.terminal", label: "Paid", config: { outcome: "completed", message: "Supplier paid through PayPal Payouts" } },
    { id: "not_usd", type: "control.terminal", label: "Not USD", config: { outcome: "needs_review", message: "Bill is not in USD; handle manually" } },
    { id: "refused", type: "control.terminal", label: "PayPal refused", config: { outcome: "needs_review", message: "PayPal refused the payout; see the PayPal error" } },
  ],
  edges: [
    { from: "ask", to: "extract", port: "next" },
    { from: "extract", to: "purpose", port: "done" },
    { from: "purpose", to: "behavior", port: "done" },
    { from: "behavior", to: "contract", port: "done" },
    { from: "contract", to: "usd", port: "done" },
    { from: "usd", to: "pay", port: "pass" },
    { from: "usd", to: "not_usd", port: "block" },
    { from: "pay", to: "paid", port: "done" },
    { from: "pay", to: "refused", port: "error" },
  ],
};

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(and(eq(users.workspaceId, workspaceId), eq(users.role, "OWNER"))).limit(1);
  const [wf] = await db().select({ id: workflows.id }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.name, "Cloud procurement")));
  if (!wf) throw new Error('Run pnpm db:seed:phase6 first ("Cloud procurement" not found)');
  const r = await saveDraft({ workspaceId, userId: owner.id, workflowId: wf.id, graph });
  console.log(r.ok ? `Cloud procurement draft v${r.version} saved (${wf.id})${r.validation.ok ? "" : " — has validation issues"}` : JSON.stringify(r));
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
