/**
 * Phase 6 demo state (no AI). Creates the hand-built "Cloud procurement"
 * workflow as a DRAFT (activation stays a human action in the Flow Builder) and
 * grants the existing Phase-5 workflows explicit, audited delegated authority —
 * without it every PayPal action they reach would wait for a person.
 * The "Cloud procurement" authority itself is created by the owner in the UI.
 *
 *   pnpm db:seed:phase6
 */
import "./load-env";
import { and, eq } from "drizzle-orm";
import { createAuthority } from "../src/server/authority/service";
import { closeDb, db } from "../src/server/db/client";
import { authorities, users, workflows } from "../src/server/db/schema";
import type { WorkflowGraph } from "../src/server/workflow/dsl/nodes";
import { createWorkflow } from "../src/server/workflow/service";
import { merchantWorkspaceId } from "../src/server/workspace";

const procurement: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "bill", type: "trigger.manual", label: "Cloud bill to pay", config: {} },
    { id: "usd", type: "policy.currency", label: "Bill is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    { id: "pay", type: "paypal.payout", label: "Pay the cloud supplier", config: { receiverRef: "trigger.supplierEmail", amountRef: "trigger.amount", note: "Payment from PixelForge Studio" } },
    { id: "paid", type: "control.terminal", label: "Paid", config: { outcome: "completed", message: "Supplier paid through PayPal Payouts" } },
    { id: "not_usd", type: "control.terminal", label: "Not USD", config: { outcome: "needs_review", message: "Bill is not in USD; handle manually" } },
    { id: "refused", type: "control.terminal", label: "PayPal refused", config: { outcome: "needs_review", message: "PayPal refused the payout; see the PayPal error" } },
  ],
  edges: [
    { from: "bill", to: "usd", port: "next" },
    { from: "usd", to: "pay", port: "pass" },
    { from: "usd", to: "not_usd", port: "block" },
    { from: "pay", to: "paid", port: "done" },
    { from: "pay", to: "refused", port: "error" },
  ],
};

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(and(eq(users.workspaceId, workspaceId), eq(users.role, "OWNER"))).limit(1);
  const wf = async (name: string) => (await db().select({ id: workflows.id }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.name, name))))[0]?.id;

  if (!(await wf("Cloud procurement"))) {
    const r = await createWorkflow({ workspaceId, userId: owner.id, name: "Cloud procurement", graph: procurement });
    console.log(r.ok ? `created workflow ${r.workflowId}  Cloud procurement (draft)` : JSON.stringify(r));
  }

  const grants: { name: string; workflows: string[]; data: Record<string, unknown> }[] = [
    {
      name: "Customer refunds",
      workflows: ["Refund desk"],
      data: { actions: ["paypal.refund"], counterpartyRule: "any", currencies: ["USD"], perTransactionMax: "500", budgetAmount: "1500", budgetPeriod: "month", description: "Refunds to customers on PayPal captures" },
    },
    {
      name: "Supplier payouts",
      workflows: ["Supplier payouts"],
      data: {
        actions: ["paypal.payout"],
        counterpartyRule: "allowlist",
        counterparties: [
          { id: "billing@cloudhost.example", name: "CloudHost" },
          { id: "studio@type-foundry.example", name: "Type Foundry" },
        ],
        currencies: ["USD"],
        perTransactionMax: "1000",
        budgetAmount: "3000",
        budgetPeriod: "month",
      },
    },
    {
      name: "Client billing",
      workflows: ["Client invoicing", "Overdue invoice reminder"],
      data: { actions: ["paypal.invoice_send", "paypal.invoice_remind"], counterpartyRule: "any", currencies: ["USD"], perTransactionMax: "10000", maxCount: 50, countPeriod: "day" },
    },
    {
      name: "Checkout capture",
      workflows: ["Capture approved orders"],
      data: { actions: ["paypal.order_capture"], counterpartyRule: "any", currencies: ["USD"], perTransactionMax: "1000" },
    },
  ];
  for (const g of grants) {
    const [exists] = await db().select({ id: authorities.id }).from(authorities).where(and(eq(authorities.workspaceId, workspaceId), eq(authorities.name, g.name)));
    if (exists) {
      console.log(`exists    ${exists.id}  ${g.name}`);
      continue;
    }
    const ids = (await Promise.all(g.workflows.map(wf))).filter((x): x is string => !!x);
    const r = await createAuthority({ workspaceId, userId: owner.id, data: { name: g.name, workflowIds: ids, ...g.data } });
    console.log(r.ok ? `authority ${r.id}  ${g.name}` : `${g.name}: ${r.error}`);
  }
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
