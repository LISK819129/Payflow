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
    description: "An external agent requests an action under a scoped, expiring capability.",
    config: z.object({ capabilityTemplate: z.string().max(80).optional() }).strict(),
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
    description: "Passes only if the amount is at or below the limit, in the same currency.",
    config: z.object({ amountRef: Ref, max: Money }).strict(),
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
    description: "Reserves the amount against a rolling budget; blocks if it would exceed it.",
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
    description: "Blocks after N passes in a period.",
    config: z.object({ max: z.number().int().min(1).max(10000), period: z.enum(["hour", "day", "week", "month"]), key: z.string().min(1).max(80) }).strict(),
    ports: ["pass", "block", "error"],
    requiredPorts: ["pass", "block"],
    implementedIn: 6,
    isPolicy: true,
  }),

  // ── PayPal actions ────────────────────────────────────────────────────────
  spec({
    type: "paypal.payout",
    category: "paypal",
    title: "Send payout",
    description: "Pays a PayPal account (Payouts API).",
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
    description: "Refunds a captured payment, fully or partially.",
    config: z.object({ captureIdRef: Ref, amountRef: Ref.optional(), note: z.string().max(200) }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done", "error"],
    implementedIn: 5,
    movesMoney: true,
    refKeys: ["captureIdRef", "amountRef"],
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

  // ── Ledger ────────────────────────────────────────────────────────────────
  spec({
    type: "ledger.reconcile",
    category: "ledger",
    title: "Reconcile",
    description: "Marks the matched invoice as settled by this payment in PayFlow's ledger.",
    config: z.object({ paymentRef: Ref, invoiceIdRef: Ref }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 5,
    refKeys: ["paymentRef", "invoiceIdRef"],
  }),

  // ── AI (output is evidence for policy/condition nodes, never an instruction) ─
  spec({
    type: "ai.invoice_match",
    category: "ai",
    title: "AI invoice match",
    description: "Finds the open invoice this payment settles, with confidence and evidence.",
    config: z.object({ paymentRef: Ref, counterpartyRef: Ref.optional() }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["paymentRef", "counterpartyRef"],
  }),
  spec({
    type: "ai.behavior_analysis",
    category: "ai",
    title: "AI behaviour analysis",
    description: "Compares this transaction with the counterparty's history; returns a risk level and anomalies.",
    config: z.object({ paymentRef: Ref, counterpartyRef: Ref }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
    refKeys: ["paymentRef", "counterpartyRef"],
  }),
  spec({
    type: "ai.purpose_classification",
    category: "ai",
    title: "AI purpose classification",
    description: "Classifies what a request is for against an allowed category list.",
    config: z.object({ textRefs: z.array(Ref).min(1).max(5), categories: z.array(z.string().min(1).max(60)).min(2).max(30) }).strict(),
    ports: ["done", "error"],
    requiredPorts: ["done"],
    implementedIn: 7,
    isAI: true,
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
