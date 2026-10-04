/**
 * Seeds the hand-built (USER_PROVIDED) Phase 5 workflows that reach real PayPal
 * Sandbox actions. No AI is involved. Each is created as a DRAFT; activation
 * stays a human action in the Flow Builder. Re-running leaves unchanged flows
 * alone and saves a changed graph as a new draft version for the owner to activate.
 *
 *   pnpm db:seed:phase5
 */
import "./load-env";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { users, workflows } from "../src/server/db/schema";
import type { WorkflowGraph } from "../src/server/workflow/dsl/nodes";
import { createWorkflow, saveDraft } from "../src/server/workflow/service";
import { merchantWorkspaceId } from "../src/server/workspace";

const usd = (value: string) => ({ value, currency: "USD" });
const end = (id: string, outcome: "completed" | "blocked" | "rejected" | "needs_review", message: string, label = message) => ({
  id,
  type: "control.terminal",
  label,
  config: { outcome, message },
});

/** Support desk refunds: small ones go straight through, larger ones need the owner. */
const refundDesk: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "request", type: "trigger.manual", label: "Refund requested by support", config: {} },
    { id: "usd", type: "policy.currency", label: "Refund is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    { id: "small", type: "policy.amount_limit", label: "Up to $100 refunds automatically", config: { amountRef: "trigger.amount", max: usd("100.00"), comparison: "lte" } },
    { id: "owner", type: "control.approval", label: "Owner approves refunds over $100", config: { reason: "Refund is over $100", amountRef: "trigger.amount" } },
    { id: "refund", type: "paypal.refund", label: "Refund the customer", config: { captureIdRef: "trigger.captureId", amountRef: "trigger.amount", note: "Refund from PixelForge Studio" } },
    end("refunded", "completed", "Refund sent through PayPal", "Refunded"),
    end("declined", "rejected", "Owner declined the refund", "Declined"),
    end("not_usd", "needs_review", "Refund is not in USD; handle manually", "Not USD"),
    end("paypal_refused", "needs_review", "PayPal refused the refund; see the PayPal error", "PayPal refused"),
  ],
  edges: [
    { from: "request", to: "usd", port: "next" },
    { from: "usd", to: "small", port: "pass" },
    { from: "usd", to: "not_usd", port: "block" },
    { from: "small", to: "refund", port: "pass" },
    { from: "small", to: "owner", port: "block" },
    { from: "owner", to: "refund", port: "approved" },
    { from: "owner", to: "declined", port: "rejected" },
    { from: "refund", to: "refunded", port: "done" },
    { from: "refund", to: "paypal_refused", port: "error" },
  ],
};

const SUPPLIERS = ["billing@cloudhost.example", "studio@type-foundry.example"];

/** Supplier payouts: only known suppliers, USD, up to $500 without asking. */
const supplierPayouts: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "bill", type: "trigger.manual", label: "Supplier bill to pay", config: {} },
    { id: "known", type: "policy.counterparty", label: "Supplier is on the approved list", config: { ref: "trigger.supplierEmail", allowed: SUPPLIERS } },
    { id: "usd", type: "policy.currency", label: "Bill is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    { id: "limit", type: "policy.amount_limit", label: "Up to $500 pays automatically", config: { amountRef: "trigger.amount", max: usd("500.00"), comparison: "lte" } },
    { id: "owner", type: "control.approval", label: "Owner approves payouts over $500", config: { reason: "Supplier payout over $500", amountRef: "trigger.amount", counterpartyRef: "trigger.supplierEmail" } },
    { id: "payout", type: "paypal.payout", label: "Pay the supplier", config: { receiverRef: "trigger.supplierEmail", amountRef: "trigger.amount", note: "Payment from PixelForge Studio" } },
    end("paid", "completed", "Supplier paid through PayPal Payouts", "Paid"),
    end("unknown_supplier", "blocked", "Not an approved supplier; nothing was paid", "Unknown supplier"),
    end("not_usd", "needs_review", "Bill is not in USD; handle manually", "Not USD"),
    end("declined", "rejected", "Owner declined the payout", "Declined"),
    end("paypal_refused", "needs_review", "PayPal refused the payout; see the PayPal error", "PayPal refused"),
  ],
  edges: [
    { from: "bill", to: "known", port: "next" },
    { from: "known", to: "usd", port: "pass" },
    { from: "known", to: "unknown_supplier", port: "block" },
    { from: "usd", to: "limit", port: "pass" },
    { from: "usd", to: "not_usd", port: "block" },
    { from: "limit", to: "payout", port: "pass" },
    { from: "limit", to: "owner", port: "block" },
    { from: "owner", to: "payout", port: "approved" },
    { from: "owner", to: "declined", port: "rejected" },
    { from: "payout", to: "paid", port: "done" },
    { from: "payout", to: "paypal_refused", port: "error" },
  ],
};

/** Client invoicing: USD invoices up to $5,000 go out; bigger ones need the owner. */
const clientInvoicing: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "job", type: "trigger.manual", label: "Project ready to bill", config: {} },
    { id: "usd", type: "policy.currency", label: "Invoice is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    { id: "limit", type: "policy.amount_limit", label: "Up to $5,000 sends automatically", config: { amountRef: "trigger.amount", max: usd("5000.00"), comparison: "lte" } },
    { id: "owner", type: "control.approval", label: "Owner approves invoices over $5,000", config: { reason: "Invoice over $5,000", amountRef: "trigger.amount", counterpartyRef: "trigger.clientEmail" } },
    {
      id: "invoice",
      type: "paypal.invoice_send",
      label: "Send the PayPal invoice",
      config: { recipientRef: "trigger.clientEmail", amountRef: "trigger.amount", description: "Design services", dueDateRef: "trigger.dueDate", note: "Thank you for working with PixelForge Studio" },
    },
    end("sent", "completed", "Invoice sent through PayPal", "Sent"),
    end("not_usd", "needs_review", "Invoice is not in USD; handle manually", "Not USD"),
    end("declined", "rejected", "Owner declined the invoice", "Declined"),
    end("paypal_refused", "needs_review", "PayPal refused the invoice; see the PayPal error", "PayPal refused"),
  ],
  edges: [
    { from: "job", to: "usd", port: "next" },
    { from: "usd", to: "limit", port: "pass" },
    { from: "usd", to: "not_usd", port: "block" },
    { from: "limit", to: "invoice", port: "pass" },
    { from: "limit", to: "owner", port: "block" },
    { from: "owner", to: "invoice", port: "approved" },
    { from: "owner", to: "declined", port: "rejected" },
    { from: "invoice", to: "sent", port: "done" },
    { from: "invoice", to: "paypal_refused", port: "error" },
  ],
};

/** Overdue invoice reminder: always asks the owner before contacting the client. */
const invoiceReminder: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "overdue", type: "trigger.manual", label: "Invoice is overdue", config: {} },
    { id: "owner", type: "control.approval", label: "Owner approves the reminder", config: { reason: "Send a payment reminder to the client" } },
    { id: "remind", type: "paypal.invoice_remind", label: "Send a polite reminder", config: { invoiceIdRef: "trigger.invoiceId", subject: "A friendly reminder from PixelForge Studio" } },
    end("reminded", "completed", "Reminder sent through PayPal", "Reminded"),
    end("declined", "rejected", "Owner chose not to send a reminder", "Not sent"),
    end("paypal_refused", "needs_review", "PayPal refused the reminder; see the PayPal error", "PayPal refused"),
  ],
  edges: [
    { from: "overdue", to: "owner", port: "next" },
    { from: "owner", to: "remind", port: "approved" },
    { from: "owner", to: "declined", port: "rejected" },
    { from: "remind", to: "reminded", port: "done" },
    { from: "remind", to: "paypal_refused", port: "error" },
  ],
};

/** Approved checkout orders: capture only the expected USD amount, up to $1,000. */
const orderCapture: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "order", type: "trigger.manual", label: "Buyer approved an order", config: {} },
    { id: "usd", type: "policy.currency", label: "Order is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
    { id: "limit", type: "policy.amount_limit", label: "Up to $1,000 captures automatically", config: { amountRef: "trigger.amount", max: usd("1000.00"), comparison: "lte" } },
    { id: "owner", type: "control.approval", label: "Owner approves captures over $1,000", config: { reason: "Order over $1,000", amountRef: "trigger.amount" } },
    { id: "capture", type: "paypal.order_capture", label: "Capture the payment", config: { orderIdRef: "trigger.orderId", amountRef: "trigger.amount" } },
    end("captured", "completed", "Payment captured through PayPal", "Captured"),
    end("not_usd", "needs_review", "Order is not in USD; handle manually", "Not USD"),
    end("declined", "rejected", "Owner declined the capture", "Declined"),
    end("paypal_refused", "needs_review", "Capture refused; see the PayPal error", "Refused"),
  ],
  edges: [
    { from: "order", to: "usd", port: "next" },
    { from: "usd", to: "limit", port: "pass" },
    { from: "usd", to: "not_usd", port: "block" },
    { from: "limit", to: "capture", port: "pass" },
    { from: "limit", to: "owner", port: "block" },
    { from: "owner", to: "capture", port: "approved" },
    { from: "owner", to: "declined", port: "rejected" },
    { from: "capture", to: "captured", port: "done" },
    { from: "capture", to: "paypal_refused", port: "error" },
  ],
};

/** When PayPal reports an invoice paid, confirm it with PayPal and record it in the ledger. */
const reconcilePaid: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "paid", type: "trigger.paypal_event", label: "PayPal invoice paid", config: { eventTypes: ["INVOICING.INVOICE.PAID"] } },
    { id: "reconcile", type: "ledger.reconcile", label: "Match payment to invoice", config: { paymentRef: "trigger.paidAmount", invoiceIdRef: "trigger.invoiceId" } },
    end("matched", "completed", "Invoice settled and recorded in the ledger", "Reconciled"),
    end("mismatch", "needs_review", "Payment does not match the invoice; review it", "Mismatch"),
  ],
  edges: [
    { from: "paid", to: "reconcile", port: "next" },
    { from: "reconcile", to: "matched", port: "done" },
    { from: "reconcile", to: "mismatch", port: "error" },
  ],
};

/** Read-only: look up a PayPal object and recent activity. Moves no money, contacts no one. */
const activityCheck: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "ask", type: "trigger.manual", label: "Check a payment", config: {} },
    { id: "lookup", type: "paypal.fetch", label: "Look up the capture", config: { resource: "capture", idRef: "trigger.captureId" } },
    { id: "recent", type: "paypal.transaction_search", label: "Last 7 days of activity", config: { days: 7 } },
    end("checked", "completed", "PayPal lookup and activity search done", "Checked"),
    end("lookup_failed", "needs_review", "PayPal could not find that capture", "Not found"),
  ],
  edges: [
    { from: "ask", to: "lookup", port: "next" },
    { from: "lookup", to: "recent", port: "done" },
    { from: "lookup", to: "lookup_failed", port: "error" },
    { from: "recent", to: "checked", port: "done" },
  ],
};

const FLOWS: [string, WorkflowGraph][] = [
  ["Refund desk", refundDesk],
  ["Supplier payouts", supplierPayouts],
  ["Client invoicing", clientInvoicing],
  ["Overdue invoice reminder", invoiceReminder],
  ["Capture approved orders", orderCapture],
  ["Reconcile paid invoices", reconcilePaid],
  ["PayPal activity check", activityCheck],
];

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(eq(users.workspaceId, workspaceId)).limit(1);
  for (const [name, graph] of FLOWS) {
    const [existing] = await db()
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.name, name)));
    if (existing) {
      // saveDraft is a no-op when the meaning is unchanged; otherwise it drafts the next version.
      const r = await saveDraft({ workspaceId, userId: owner.id, workflowId: existing.id, graph });
      console.log(r.ok ? `v${r.version}     ${existing.id}  ${name}` : JSON.stringify(r));
      continue;
    }
    const r = await createWorkflow({ workspaceId, userId: owner.id, name, graph });
    console.log(r.ok ? `created ${r.workflowId}  ${name}` : JSON.stringify(r));
  }
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
