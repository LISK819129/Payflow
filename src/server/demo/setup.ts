import { and, desc, eq, isNotNull } from "drizzle-orm";
import { JUDGE_DEPLOYMENT } from "../deploy/config";
import { appendAudit } from "../audit/audit";
import { canonicalJson } from "../audit/canonical";
import { createAuthority, setAuthorityStatus, updateAuthority } from "../authority/service";
import { registerAgent } from "../agents/service";
import { db } from "../db/client";
import { agents, authorities, workflowVersions, workflows } from "../db/schema";
import type { WorkflowGraph } from "../workflow/dsl/nodes";
import { activateLatest, createWorkflow, saveDraft, setWorkflowState } from "../workflow/service";

/**
 * Judge / demo environment.
 *
 * The demo setup is configuration only — two workflows, their authorities and
 * one agent — created and restored through the same audited services a person
 * uses. It never creates runs, payments, approvals or PayPal objects, never
 * deletes anything, and touches only records carrying a `demo_key`.
 * "Restore" therefore means: put demo configuration back the way it was by
 * making new versions; history (runs, decisions, receipts, audit) is untouched.
 */

export const DEMO_KEYS = { cloud: "demo:cloud-procurement", refunds: "demo:customer-refunds", cloudAuthority: "demo:cloud-procurement-authority", refundAuthority: "demo:customer-refunds-authority", agent: "demo:cloud-procurement-agent" } as const;

export function demoModeEnabled(): boolean {
  return process.env.PAYFLOW_DEMO_MODE === "true";
}

/**
 * Demo suppliers: two real PayPal Sandbox *personal* accounts (identifiers, not secrets), so a
 * demo payout ends Settled. DEMO_SUPPLIER_*_EMAIL can point the demo elsewhere.
 */
export function demoSuppliers() {
  return {
    acme: process.env.DEMO_SUPPLIER_ACME_EMAIL || JUDGE_DEPLOYMENT.suppliers.acme.email,
    aws: process.env.DEMO_SUPPLIER_AWS_EMAIL || JUDGE_DEPLOYMENT.suppliers.aws.email,
  };
}

export const CLOUD_SCOPE = "Cloud infrastructure for PixelForge's own systems: compute (including GPU), storage, networking, managed databases, and support for those services.";

export function cloudGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "ask", type: "trigger.agent_request", label: "Cloud bill to pay", config: { actions: ["paypal.payout"] } },
      { id: "extract", type: "ai.invoice_extract", label: "Read the invoice", config: { documentRef: "trigger.invoice", amountRef: "trigger.amount" } },
      { id: "purpose", type: "ai.purpose_classification", label: "What is it for?", config: { textRefs: ["trigger.purpose", "trigger.invoice"], amountRef: "trigger.amount", counterpartyRef: "trigger.counterparty", action: "paypal.payout" } },
      { id: "behavior", type: "ai.behavior_analysis", label: "Compare with history", config: { paymentRef: "trigger.amount", counterpartyRef: "trigger.counterparty", descriptionRef: "trigger.purpose", action: "paypal.payout", explain: "when_flagged" } },
      { id: "usd", type: "policy.currency", label: "Bill is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
      { id: "pay", type: "paypal.payout", label: "Pay the cloud supplier", config: { receiverRef: "trigger.counterparty", amountRef: "trigger.amount", note: "Payment from PixelForge Studio" } },
      { id: "sent", type: "control.terminal", label: "Sent to PayPal", config: { outcome: "completed", message: "Payout submitted to PayPal" } },
      { id: "not_usd", type: "control.terminal", label: "Not USD", config: { outcome: "needs_review", message: "Bill is not in USD; handle manually" } },
      { id: "refused", type: "control.terminal", label: "PayPal refused", config: { outcome: "needs_review", message: "PayPal refused the payout; see the PayPal error" } },
    ],
    edges: [
      { from: "ask", to: "extract", port: "next" },
      { from: "extract", to: "purpose", port: "done" },
      { from: "purpose", to: "behavior", port: "done" },
      { from: "behavior", to: "usd", port: "done" },
      { from: "usd", to: "pay", port: "pass" },
      { from: "usd", to: "not_usd", port: "block" },
      { from: "pay", to: "sent", port: "done" },
      { from: "pay", to: "refused", port: "error" },
    ],
  } as WorkflowGraph;
}

export function refundsGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "ask", type: "trigger.manual", label: "Customer refund requested", config: {} },
      { id: "usd", type: "policy.currency", label: "Refund is in USD", config: { amountRef: "trigger.amount", allowed: ["USD"] } },
      { id: "refund", type: "paypal.refund", label: "Refund the customer", config: { captureIdRef: "trigger.captureId", amountRef: "trigger.amount", note: "Refund from PixelForge Studio" } },
      { id: "sent", type: "control.terminal", label: "Sent to PayPal", config: { outcome: "completed", message: "Refund submitted to PayPal" } },
      { id: "not_usd", type: "control.terminal", label: "Not USD", config: { outcome: "needs_review", message: "Refund is not in USD; handle manually" } },
      { id: "refused", type: "control.terminal", label: "PayPal refused", config: { outcome: "needs_review", message: "PayPal refused the refund; see the PayPal error" } },
    ],
    edges: [
      { from: "ask", to: "usd", port: "next" },
      { from: "usd", to: "refund", port: "pass" },
      { from: "usd", to: "not_usd", port: "block" },
      { from: "refund", to: "sent", port: "done" },
      { from: "refund", to: "refused", port: "error" },
    ],
  } as WorkflowGraph;
}

export type TestExample = { label: string; values: Record<string, string | { value: string; currency_code: string }> };

/**
 * Input presets for testing the demo Cloud procurement flow. They only fill the
 * Test Run form — the verdict always comes from the engine.
 */
export function cloudTestExamples(): TestExample[] {
  const s = demoSuppliers();
  const inv = (from: string, n: string, item: string, total: string) => `From: ${from}\nInvoice ${n}\nFor: ${item}\nTotal: $${total} USD\nTerms: Net 30`;
  return [
    { label: "$185 · Acme Cloud · GPU compute", values: { amount: { value: "185.00", currency_code: "USD" }, counterparty: s.acme, purpose: "GPU compute for model training", invoice: inv("Acme Cloud", "AC-9101", "GPU compute, 37 hours on A100 instances", "185.00") } },
    { label: "$470 · Acme Cloud · digital gift cards", values: { amount: { value: "470.00", currency_code: "USD" }, counterparty: s.acme, purpose: "10 x $47 digital gift cards", invoice: inv("Acme Cloud", "AC-9102", "10 x $47 digital gift cards", "470.00") } },
    { label: "$650 · AWS · GPU compute", values: { amount: { value: "650.00", currency_code: "USD" }, counterparty: s.aws, purpose: "EC2 GPU instances for model training", invoice: inv("Amazon Web Services", "AWS-9103", "EC2 GPU instances (p4d)", "650.00") } },
  ];
}

function cloudAuthority(workflowId: string) {
  const s = demoSuppliers();
  return {
    name: "Cloud procurement",
    description: "Demo setup: what the Cloud procurement workflow — and agents asking through it — may pay without a person.",
    workflowIds: [workflowId],
    actions: ["paypal.payout"],
    counterpartyRule: "allowlist" as const,
    counterparties: [
      { id: s.acme, name: "Acme Cloud" },
      { id: s.aws, name: "AWS" },
    ],
    deniedCounterparties: [{ id: "payments@blocked-vendor.example", name: "Blocked Vendor" }],
    currencies: ["USD"],
    perTransactionMax: "500",
    budgetAmount: "5000",
    budgetPeriod: "month" as const,
    purposeScope: CLOUD_SCOPE,
    intelligencePolicy: {},
  };
}

function refundAuthority(workflowId: string) {
  return {
    name: "Customer refunds",
    description: "Demo setup: refunds up to $100 go through on their own; anything larger asks a person.",
    workflowIds: [workflowId],
    actions: ["paypal.refund"],
    counterpartyRule: "any" as const,
    counterparties: [],
    deniedCounterparties: [],
    currencies: ["USD"],
    perTransactionMax: "100",
    budgetAmount: "1000",
    budgetPeriod: "month" as const,
    intelligencePolicy: {},
  };
}

type Change = string;

async function ensureWorkflow(workspaceId: string, userId: string, key: string, name: string, description: string, graph: WorkflowGraph, changes: Change[]): Promise<string> {
  const [wf] = await db().select().from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.demoKey, key)));
  if (!wf) {
    const c = await createWorkflow({ workspaceId, userId, name, description, graph });
    if (!c.ok) throw new Error(`demo workflow ${name}: ${JSON.stringify(c)}`);
    await db().update(workflows).set({ demoKey: key }).where(eq(workflows.id, c.workflowId));
    const a = await activateLatest({ workspaceId, userId, workflowId: c.workflowId });
    if (!a.ok) throw new Error(`activate ${name}: ${JSON.stringify(a)}`);
    changes.push(`created and activated “${name}”`);
    return c.workflowId;
  }
  const [active] = wf.activeVersionId ? await db().select().from(workflowVersions).where(eq(workflowVersions.id, wf.activeVersionId)) : [];
  const [latest] = await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)).orderBy(desc(workflowVersions.version)).limit(1);
  const same = (g: unknown) => canonicalJson({ n: (g as WorkflowGraph).nodes, e: (g as WorkflowGraph).edges }) === canonicalJson({ n: graph.nodes, e: graph.edges });
  if (!active || !same(active.graph) || (latest && !same(latest.graph))) {
    // A new version, never an edit of history.
    const d = await saveDraft({ workspaceId, userId, workflowId: wf.id, graph });
    if (!d.ok) throw new Error(`restore ${name}: ${JSON.stringify(d)}`);
    const a = await activateLatest({ workspaceId, userId, workflowId: wf.id });
    if (!a.ok) throw new Error(`activate ${name}: ${JSON.stringify(a)}`);
    changes.push(`restored “${name}” as a new version`);
  }
  const [now] = await db().select().from(workflows).where(eq(workflows.id, wf.id));
  if (now.state !== "ACTIVE") {
    await setWorkflowState({ workspaceId, userId, workflowId: wf.id, to: "ACTIVE" });
    changes.push(`resumed “${name}”`);
  }
  if (now.observing) await db().update(workflows).set({ observing: false, observingSince: null }).where(eq(workflows.id, wf.id));
  return wf.id;
}

async function ensureAuthority(workspaceId: string, userId: string, key: string, data: ReturnType<typeof cloudAuthority> | ReturnType<typeof refundAuthority>, changes: Change[]) {
  const [a] = await db().select().from(authorities).where(and(eq(authorities.workspaceId, workspaceId), eq(authorities.demoKey, key)));
  if (!a) {
    const r = await createAuthority({ workspaceId, userId, data });
    if (!r.ok) throw new Error(`demo authority ${data.name}: ${r.error}`);
    await db().update(authorities).set({ demoKey: key }).where(eq(authorities.id, r.id));
    changes.push(`created authority “${data.name}”`);
    return;
  }
  const want = canonicalJson({ ...data, perTransactionMax: Number(data.perTransactionMax).toFixed(2), budgetAmount: Number(data.budgetAmount).toFixed(2), purposeScope: "purposeScope" in data ? data.purposeScope : null });
  const have = canonicalJson({
    name: a.name,
    description: a.description,
    workflowIds: a.workflowIds,
    actions: a.actions,
    counterpartyRule: a.counterpartyRule,
    counterparties: a.counterparties,
    deniedCounterparties: a.deniedCounterparties,
    currencies: a.currencies,
    perTransactionMax: a.perTransactionMax,
    budgetAmount: a.budgetAmount,
    budgetPeriod: a.budgetPeriod,
    purposeScope: a.purposeScope,
    intelligencePolicy: a.intelligencePolicy,
  });
  if (want !== have) {
    const r = await updateAuthority({ workspaceId, userId, authorityId: a.id, data });
    if (!r.ok) throw new Error(`restore authority ${data.name}: ${r.error}`);
    changes.push(`restored authority “${data.name}” as a new version`);
  }
  if (a.status !== "ACTIVE") {
    await setAuthorityStatus({ workspaceId, userId, authorityId: a.id, to: "ACTIVE", reason: "Demo setup restored" });
    changes.push(`reactivated authority “${data.name}”`);
  }
}

export type RestoreResult = { changes: Change[]; agentToken: string | null; cloudWorkflowId: string; refundsWorkflowId: string };

/**
 * Creates the demo setup, or restores it to its canonical form. Idempotent.
 * Returns a new agent credential only if the demo agent had to be (re)issued —
 * revoked or expired agents are never revived; a new identity is registered.
 */
export async function restoreDemo(input: { workspaceId: string; userId: string }): Promise<RestoreResult> {
  const changes: Change[] = [];
  const cloud = await ensureWorkflow(input.workspaceId, input.userId, DEMO_KEYS.cloud, "Cloud procurement", "Pays cloud suppliers when a person or an AI agent asks — within delegated authority.", cloudGraph(), changes);
  const refunds = await ensureWorkflow(input.workspaceId, input.userId, DEMO_KEYS.refunds, "Customer refunds", "Refunds a PayPal capture on request — small refunds on their own, larger ones with a person.", refundsGraph(), changes);
  await ensureAuthority(input.workspaceId, input.userId, DEMO_KEYS.cloudAuthority, cloudAuthority(cloud), changes);
  await ensureAuthority(input.workspaceId, input.userId, DEMO_KEYS.refundAuthority, refundAuthority(refunds), changes);

  let agentToken: string | null = null;
  const live = await db()
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, input.workspaceId), eq(agents.demoKey, DEMO_KEYS.agent), eq(agents.status, "ACTIVE"), isNotNull(agents.demoKey)));
  const usable = live.find((a) => (!a.expiresAt || a.expiresAt > new Date()) && a.scopes.some((s) => s.workflowId === cloud));
  if (!usable) {
    const r = await registerAgent({
      workspaceId: input.workspaceId,
      userId: input.userId,
      name: "Cloud Procurement Agent",
      description: "Demo agent: asks PayFlow to pay cloud suppliers. It can ask; it cannot approve, change rules or reach PayPal.",
      scopes: [{ workflowId: cloud, actions: ["paypal.payout"], modes: ["LIVE", "TEST"] }],
      expiresAt: new Date(Date.now() + 60 * 86_400_000),
    });
    if (!r.ok) throw new Error(`demo agent: ${r.error}`);
    await db().update(agents).set({ demoKey: DEMO_KEYS.agent }).where(eq(agents.id, r.agent.id));
    agentToken = r.token;
    changes.push("registered a new Cloud Procurement Agent (credential shown once)");
  }

  await db().transaction((tx) =>
    appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "demo.restored",
      summary: changes.length ? `Demo setup restored: ${changes.join("; ")}` : "Demo setup checked: already as configured",
      payload: { changes, demoKeys: Object.values(DEMO_KEYS) },
    }),
  );
  return { changes, agentToken, cloudWorkflowId: cloud, refundsWorkflowId: refunds };
}
