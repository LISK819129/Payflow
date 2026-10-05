import { z } from "zod";
import { Expr, Ref } from "./expression";

/**
 * The node catalogue. Each type declares its config schema, output ports,
 * category and the phase that implements its executor. The validator, the
 * runtime, the compiler prompt and the Flow Builder's node library are all
 * generated from this table — there is no second list to drift out of sync.
 */

export const Money = z
  .object({
    value: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "amount like 500 or 500.00"),
    currency: z.string().regex(/^[A-Z]{3}$/, "ISO currency code"),
  })
  .strict();
export type Money = z.infer<typeof Money>;

const label = z.string().trim().min(1).max(120);

export type NodeCategory = "trigger" | "control" | "policy" | "paypal" | "ai" | "ledger";

export type NodeSpec = {
  type: string;
  category: NodeCategory;
  title: string;
  description: string;
  config: z.ZodTypeAny;
  /** Ports this node can leave through. `error` is always optional. */
  ports: readonly string[];
  /** Ports that must have an outgoing edge for the graph to be valid. */
  requiredPorts: readonly string[];
  /** Phase whose runtime executes this node. Nodes from later phases may be drafted but not activated. */
  implementedIn: number;
  movesMoney?: boolean;
  /** Sends something to a third party (email, reminder) — treated like money for approval routing. */
  external?: boolean;
  isPolicy?: boolean;
  isAI?: boolean;
  /** Config keys whose values are refs read at run time (for dependency validation). */
  refKeys?: readonly string[];
};

const spec = <T extends z.ZodTypeAny>(s: Omit<NodeSpec, "config"> & { config: T }) => s;

export const NODE_SPECS = [
  // ── Triggers ──────────────────────────────────────────────────────────────
  spec({
    type: "trigger.manual",
    category: "trigger",
    title: "Manual",
    description: "Started by a person, with a payload they provide (labelled user-provided).",
    config: z.object({}).strict(),
    ports: ["next"],
    requiredPorts: ["next"],
    implementedIn: 3,
  }),
  spec({
    type: "trigger.paypal_event",
    category: "trigger",
    title: "PayPal event",
    description: "A verified PayPal webhook of the listed types, optionally filtered.",
    config: z
      .object({
        eventTypes: z.array(z.string().regex(/^[A-Z0-9_.-]+$/)).min(1).max(20),
        filter: Expr.optional(),
      })
      .strict(),
    ports: ["next"],
    requiredPorts: ["next"],
    implementedIn: 3,
  }),
  spec({
    type: "trigger.schedule",
    category: "trigger",
    title: "Schedule",
    description: "Runs on a cron schedule.",
    config: z
      .object({
        cron: z.string().regex(/^(\S+\s+){4}\S+$/, "five-field cron expression"),
        timezone: z.string().max(64).default("UTC"),
      })
      .strict(),
    ports: ["next"],
    requiredPorts: ["next"],
    implementedIn: 3,
  }),
  spec({
    type: "trigger.agent_request",
    category: "trigger",
    title: "Agent request",
    description: "An authenticated external AI agent asks for an action through PayFlow's Agent Gateway. The request is data: authority, budgets, intelligence and approvals decide.",
    config: z
      .object({
        /** Which actions agents may request through this workflow (the agent's own scope must also allow them). */
        actions: z.array(z.enum(["paypal.payout", "paypal.refund"])).min(1).max(2).optional(),
        capabilityTemplate: z.string().max(80).optional(),
      })
      .strict(),
    ports: ["next"],
    requiredPorts: ["next"],
    implementedIn: 9,
  }),

  // ── Control ───────────────────────────────────────────────────────────────
  spec({
    type: "control.condition",
    category: "control",
    title: "Condition",
    description: "Routes on a deterministic expression. Missing or mismatched data takes the error path.",
    config: z.object({ expr: Expr }).strict(),
    ports: ["true", "false", "error"],
    requiredPorts: ["true", "false"],
    implementedIn: 3,
  }),
  spec({
    type: "control.approval",
    category: "control",
    title: "Human approval",
    description: "Pauses the run until an authorised person approves or rejects.",
    config: z
      .object({
        reason: label,
        amountRef: Ref.optional(),
        counterpartyRef: Ref.optional(),
        expiresAfterHours: z.number().int().min(1).max(24 * 30).optional(),
      })
      .strict(),
    ports: ["approved", "rejected"],
    requiredPorts: ["approved", "rejected"],
    implementedIn: 3,
    refKeys: ["amountRef", "counterpartyRef"],
  }),
  spec({
    type: "control.delay",
    category: "control",
    title: "Delay",
    description: "Waits a fixed time, or until a date in the data plus an offset.",
    config: z
      .object({
        minutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
        untilRef: Ref.optional(),
        offsetDays: z.number().int().min(-365).max(365).optional(),
      })
      .strict()
      .refine((c) => c.minutes !== undefined || c.untilRef !== undefined, "set minutes or untilRef"),
    ports: ["elapsed", "error"],
    requiredPorts: ["elapsed"],
    implementedIn: 3,
    refKeys: ["untilRef"],
  }),
  spec({
    type: "control.freeze",
    category: "control",
    title: "Freeze",
    description: "Freezes this workflow (and, with dependents, workflows that rely on it). Frozen workflows start no runs and suspend running ones.",
    config: z.object({ reason: label, includeDependents: z.boolean().default(true) }).strict(),
    ports: ["next"],
    requiredPorts: ["next"],
    implementedIn: 3,
  }),
  spec({
    type: "control.terminal",
    category: "control",
    title: "End",
    description: "Ends the run with an outcome.",
    config: z.object({ outcome: z.enum(["completed", "blocked", "rejected", "needs_review"]), message: label }).strict(),
    ports: [],
    requiredPorts: [],
    implementedIn: 3,
  }),

  // ── Policy (deterministic money rules) ────────────────────────────────────
  spec({
    type: "policy.amount_limit",
    category: "policy",
    title: "Amount limit",
    description:
      'Passes only if the amount is within the limit, in the same currency. comparison "lt" = strictly below max ("under $X", "less than $X"); "lte" = at or below max ("up to $X", "at most $X", "no more than $X").',
    config: z.object({ amountRef: Ref, max: Money, comparison: z.enum(["lte", "lt"]).default("lte") }).strict(),
    ports: ["pass", "block", "error"],
    requiredPorts: ["pass", "block"],
    implementedIn: 3,
    isPolicy: true,
    refKeys: ["amountRef"],
  }),
  spec({
    type: "policy.currency",
    category: "policy",
    title: "Currency restriction",
    description: "Passes only for the listed currencies.",
    config: z.object({ amountRef: Ref, allowed: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(10) }).strict(),
    ports: ["pass", "block", "error"],
    requiredPorts: ["pass", "block"],
    implementedIn: 3,
    isPolicy: true,
    refKeys: ["amountRef"],
  }),
  spec({
    type: "policy.counterparty",
    category: "policy",
    title: "Counterparty restriction",
    description: "Passes only for listed counterparties (email or PayPal id, case-insensitive).",
    config: z.object({ ref: Ref, allowed: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict(),
    ports: ["pass", "block", "error"],
    requiredPorts: ["pass", "block"],
    implementedIn: 3,
    isPolicy: true,
    refKeys: ["ref"],
  }),
  spec({
    type: "policy.budget",
    category: "policy",
    title: "Budget limit",
    description: "Reserves the exact amount against a shared budget for the calendar day/week/month (UTC); blocks if this would exceed it. Concurrent runs see each other's reservations; a reservation is released if no PayPal action on the run succeeds.",
    config: z.object({ amountRef: Ref, budget: Money, period: z.enum(["day", "week", "month"]), budgetKey: z.string().min(1).max(80) }).strict(),
    ports: ["pass", "block", "error"],
    requiredPorts: ["pass", "block"],
    implementedIn: 6,
    isPolicy: true,
    refKeys: ["amountRef"],
  }),
  spec({
    type: "policy.frequency",
    category: "policy",
    title: "Frequency limit",
    description: "Allows at most N passes per calendar hour/day/week/month (UTC) for a shared key; blocks the next one. Counts are released if no PayPal action on the run succeeds.",
    config: z.object({ max: z.number().int().min(1).max(10000), period: z.enum(["hour", "day", "week", "month"]), key: z.string().min(1).max(80) }).strict(),
    ports: ["pass", "block", "error"],
    requiredPorts: ["pass", "block"],
    implementedIn: 6,
    isPolicy: true,
  }),

  // ── PayPal actions ────────────────────────────────────────────────────────
  // Every money-moving node states an exact amount (Money ref) and currency; the
  // runtime fails closed if either is missing, malformed or inconsistent.
  spec({
    type: "paypal.payout",
    category: "paypal",
    title: "Send payout",
    description: "Pays a PayPal account by email (Payouts API).",
    config: z.object({ receiverRef: Ref, amountRef: Ref, note: z.string().max(200) }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done", "error"],
    implementedIn: 5,
    movesMoney: true,
    refKeys: ["receiverRef", "amountRef"],
  }),
  spec({
    type: "paypal.refund",
    category: "paypal",
    title: "Refund capture",
    description: "Refunds an exact amount of a captured payment back to the payer.",
    config: z.object({ captureIdRef: Ref, amountRef: Ref, note: z.string().max(200) }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done", "error"],
    implementedIn: 5,
    movesMoney: true,
    refKeys: ["captureIdRef", "amountRef"],
  }),
  spec({
    type: "paypal.order_capture",
    category: "paypal",
    title: "Capture order",
    description: "Captures a buyer-approved order, only if its amount equals the expected amount.",
    config: z.object({ orderIdRef: Ref, amountRef: Ref }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done", "error"],
    implementedIn: 5,
    movesMoney: true,
    refKeys: ["orderIdRef", "amountRef"],
  }),
  spec({
    type: "paypal.invoice_send",
    category: "paypal",
    title: "Send invoice",
    description: "Creates and sends a PayPal invoice for an exact amount to a recipient email.",
    config: z
      .object({ recipientRef: Ref, amountRef: Ref, description: z.string().min(1).max(200), dueDateRef: Ref.optional(), note: z.string().max(400).optional() })
      .strict(),
    ports: ["done", "error"],
    requiredPorts: ["done", "error"],
    implementedIn: 5,
    external: true,
    refKeys: ["recipientRef", "amountRef", "dueDateRef"],
  }),
  spec({
    type: "paypal.invoice_remind",
    category: "paypal",
    title: "Send invoice reminder",
    description: "Sends a PayPal reminder for an unpaid invoice.",
    config: z.object({ invoiceIdRef: Ref, subject: z.string().max(120).optional(), noteRef: Ref.optional() }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done", "error"],
    implementedIn: 5,
    external: true,
    refKeys: ["invoiceIdRef", "noteRef"],
  }),
  spec({
    type: "paypal.fetch",
    category: "paypal",
    title: "Fetch from PayPal",
    description: "Reads the current state of a PayPal resource (read-only).",
    config: z.object({ resource: z.enum(["capture", "order", "invoice", "dispute", "payout_item"]), idRef: Ref }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 5,
    refKeys: ["idRef"],
  }),
  spec({
    type: "paypal.transaction_search",
    category: "paypal",
    title: "Search transactions",
    description: "Lists recent PayPal transactions (read-only; PayPal indexes them with a delay of up to a few hours).",
    config: z.object({ days: z.number().int().min(1).max(31), counterpartyRef: Ref.optional() }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 5,
    refKeys: ["counterpartyRef"],
  }),

  // ── Ledger ────────────────────────────────────────────────────────────────
  spec({
    type: "ledger.reconcile",
    category: "ledger",
    title: "Reconcile",
    description: "Records in PayFlow's ledger that a PayPal invoice is settled by this payment, after confirming with PayPal that the invoice is paid for exactly this amount.",
    config: z.object({ paymentRef: Ref, invoiceIdRef: Ref }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 5,
    refKeys: ["paymentRef", "invoiceIdRef"],
  }),

  // ── AI (output is evidence for the authority engine, policy and condition nodes — never an instruction) ─
  // Every AI node reads untrusted documents as fenced data, returns PayFlow-schema evidence with provenance,
  // and has no PayPal access. Its output can never feed a money node's config (validator: ai_feeds_money)
  // and it is not a gate: money still needs a policy/approval gate and the action's delegated authority.
  spec({
    type: "ai.invoice_extract",
    category: "ai",
    title: "AI invoice reading",
    description:
      "Reads an invoice or payment request and extracts counterparty, invoice number, amount, currency, due date, purpose, terms and line items. Each value is SOURCE PROVIDED (from the given refs), AI EXTRACTED (with a quote verified in the document) or NOT FOUND; conflicts between source and document are reported. Never invents values.",
    config: z
      .object({ documentRef: Ref, amountRef: Ref.optional(), counterpartyRef: Ref.optional(), invoiceNumberRef: Ref.optional(), dueDateRef: Ref.optional() })
      .strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["documentRef", "amountRef", "counterpartyRef", "invoiceNumberRef", "dueDateRef"],
  }),
  spec({
    type: "ai.contract_match",
    category: "ai",
    title: "AI contract check",
    description: "Compares an invoice with the supplied contract (service, price, fees, parties, term). Verdict MATCH / MISMATCH / UNCERTAIN with quoted findings. MATCH is evidence, not authorization.",
    config: z.object({ invoiceRef: Ref, contractRef: Ref, amountRef: Ref, counterpartyRef: Ref.optional() }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["invoiceRef", "contractRef", "amountRef", "counterpartyRef"],
  }),
  spec({
    type: "ai.invoice_match",
    category: "ai",
    title: "AI invoice match",
    description: "Finds which open PayFlow invoice a payment settles: exact deterministic match first; the AI only chooses among several candidates. Output MATCH / NO_MATCH / UNCERTAIN.",
    config: z.object({ paymentRef: Ref, counterpartyRef: Ref.optional(), noteRef: Ref.optional() }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["paymentRef", "counterpartyRef", "noteRef"],
  }),
  spec({
    type: "ai.behavior_analysis",
    category: "ai",
    title: "AI behaviour analysis",
    description:
      "Compares this request with PayFlow's payment history. Signals (amount deviation, new counterparty, currency change, frequency, duplicate invoice) are calculated by code; the AI only explains them when they fire and may raise — never lower — the risk level. Output LOW / ELEVATED / HIGH / UNCERTAIN with evidence.",
    config: z
      .object({
        paymentRef: Ref,
        counterpartyRef: Ref,
        descriptionRef: Ref.optional(),
        invoiceNumberRef: Ref.optional(),
        action: z.enum(["paypal.payout", "paypal.refund", "paypal.order_capture", "paypal.invoice_send"]).default("paypal.payout"),
        explain: z.enum(["when_flagged", "always"]).default("when_flagged"),
      })
      .strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["paymentRef", "counterpartyRef", "descriptionRef", "invoiceNumberRef"],
  }),
  spec({
    type: "ai.purpose_classification",
    category: "ai",
    title: "AI purpose check",
    description:
      "Classifies what a payment is FOR against the purpose scope of the authority that covers this action (or an explicit scope): WITHIN_SCOPE / OUTSIDE_SCOPE / UNCERTAIN, with quoted evidence. The authority's policy decides what each answer causes.",
    config: z
      .object({
        textRefs: z.array(Ref).min(1).max(5),
        amountRef: Ref.optional(),
        counterpartyRef: Ref.optional(),
        action: z.enum(["paypal.payout", "paypal.refund", "paypal.order_capture", "paypal.invoice_send"]).default("paypal.payout"),
        scope: z.string().min(3).max(600).optional(),
        categories: z.array(z.string().min(1).max(60)).max(30).optional(),
      })
      .strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["amountRef", "counterpartyRef"],
  }),
] as const satisfies readonly NodeSpec[];

export type NodeType = (typeof NODE_SPECS)[number]["type"];

export const SPEC_BY_TYPE: Record<string, NodeSpec> = Object.fromEntries(NODE_SPECS.map((s) => [s.type, s]));

export const NodeId = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "node id: lowercase letters, digits, underscore");

/** A node as stored in a workflow version. Config is validated per type by `parseGraph`. */
export const RawNode = z
  .object({
    id: NodeId,
    type: z.string().refine((t) => t in SPEC_BY_TYPE, "unknown node type"),
    label: label.optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const Edge = z.object({ from: NodeId, to: NodeId, port: z.string().min(1).max(40) }).strict();
export type Edge = z.infer<typeof Edge>;

export const Graph = z
  .object({
    schemaVersion: z.literal(1).default(1),
    nodes: z.array(RawNode).min(1).max(80),
    edges: z.array(Edge).max(200),
    layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  })
  .strict();

export type GraphNode = { id: string; type: string; label?: string; config: Record<string, unknown> };
export type WorkflowGraph = { schemaVersion: 1; nodes: GraphNode[]; edges: Edge[]; layout?: Record<string, { x: number; y: number }> };
