import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Where a piece of data came from. Every money-shaped record carries one so the
 * UI can never present a simulated or user-entered figure as PayPal activity.
 */
export const provenance = pgEnum("provenance", [
  "REAL_PAYPAL_SANDBOX",
  "SIMULATED",
  "AI_GENERATED",
  "USER_PROVIDED",
]);

export const userRole = pgEnum("user_role", ["OWNER", "APPROVER", "VIEWER"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Base currency the business books in. */
  baseCurrency: text("base_currency").notNull().default("USD"),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("VIEWER"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the cookie value; the raw id never touches the database. */
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Append-only, hash-chained audit log. Each record commits to the previous
 * record's hash, so any edit or deletion breaks verification from that point on.
 * The application never issues UPDATE or DELETE against this table.
 */
export const auditRecords = pgTable(
  "audit_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull(),
    /** "user:<id>", "system", "ai:<model>", "paypal", "agent:<capabilityId>" */
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** Correlation handles for filtering the timeline. */
    workflowId: uuid("workflow_id"),
    runId: uuid("run_id"),
    paypalRef: text("paypal_ref"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("audit_ws_seq_uq").on(t.workspaceId, t.seq),
    index("audit_run_idx").on(t.runId),
    index("audit_workflow_idx").on(t.workflowId),
    index("audit_paypal_ref_idx").on(t.paypalRef),
  ],
);

/**
 * Every PayPal webhook delivery that passed verification (or was explicitly
 * accepted as a simulator event). `eventId` is PayPal's event id, unique, which
 * is what makes duplicate deliveries a no-op.
 */
export const paypalEvents = pgTable(
  "paypal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    summary: text("summary"),
    transmissionId: text("transmission_id"),
    verification: text("verification").notNull(),
    provenance: provenance("provenance").notNull(),
    raw: jsonb("raw").notNull(),
    /** Exact bytes PayPal signed, kept so the signature can be re-verified later (forensics, replay tests). */
    rawBody: text("raw_body"),
    /** PayPal transmission headers for the first delivery (public values, no secrets). */
    signature: jsonb("signature"),
    deliveries: integer("deliveries").notNull().default(1),
    receivedAt: timestamp("received_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    routedAt: timestamp("routed_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("paypal_events_event_id_uq").on(t.eventId),
    index("paypal_events_ws_received_idx").on(t.workspaceId, t.receivedAt),
    index("paypal_events_resource_idx").on(t.resourceId),
  ],
);

// ── Workflows ─────────────────────────────────────────────────────────────────

export const workflowState = pgEnum("workflow_state", [
  "DRAFT",
  "VALIDATING",
  "SIMULATING",
  "AWAITING_APPROVAL",
  "ACTIVE",
  "PAUSED",
  "FROZEN",
  "COMPLETED",
  "EXPIRED",
  "FAILED",
]);

export const versionStatus = pgEnum("version_status", ["DRAFT", "ACTIVE", "SUPERSEDED"]);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description"),
    state: workflowState("state").notNull().default("DRAFT"),
    activeVersionId: uuid("active_version_id"),
    /** Workflows this one depends on: freezing any of them freezes this one. */
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    frozenReason: text("frozen_reason"),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    /** The run whose Freeze node froze this workflow; only that run may continue to its end. */
    frozenByRunId: uuid("frozen_by_run_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflows_ws_idx").on(t.workspaceId)],
);

/**
 * Immutable once activated. A DRAFT version may be edited in place; editing an
 * ACTIVE workflow creates a new DRAFT version that needs its own activation.
 */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id),
    version: integer("version").notNull(),
    status: versionStatus("status").notNull().default("DRAFT"),
    graph: jsonb("graph").notNull(),
    /** sha256 of the canonical graph; recorded in the audit chain at activation. */
    graphHash: text("graph_hash").notNull(),
    provenance: provenance("provenance").notNull(),
    /** AI compilation provenance (model, prompt hash, repair attempts) when AI-generated. */
    compileMeta: jsonb("compile_meta"),
    validation: jsonb("validation"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    activatedBy: uuid("activated_by").references(() => users.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("workflow_versions_uq").on(t.workflowId, t.version)],
);

export const runStatus = pgEnum("run_status", [
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_TIMER",
  "SUSPENDED",
  "COMPLETED",
  "BLOCKED",
  "REJECTED",
  "NEEDS_REVIEW",
  "FAILED",
]);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id),
    /** Runs are pinned to the version they started on. */
    versionId: uuid("version_id")
      .notNull()
      .references(() => workflowVersions.id),
    status: runStatus("status").notNull().default("RUNNING"),
    triggerKind: text("trigger_kind").notNull(),
    /** Idempotency handle: PayPal event id, schedule slot, or a manual-run id. */
    triggerRef: text("trigger_ref").notNull(),
    triggerPayload: jsonb("trigger_payload").notNull(),
    provenance: provenance("provenance").notNull(),
    currentNodeId: text("current_node_id"),
    /** Set while waiting on a timer. */
    wakeAt: timestamp("wake_at", { withTimezone: true }),
    outcome: text("outcome"),
    startedBy: uuid("started_by").references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("workflow_runs_trigger_uq").on(t.versionId, t.triggerRef),
    index("workflow_runs_ws_idx").on(t.workspaceId, t.startedAt),
    index("workflow_runs_workflow_idx").on(t.workflowId),
  ],
);

export const stepStatus = pgEnum("step_status", ["OK", "ERROR", "WAITING"]);

/** One row per executed node. Graphs are DAGs, so a node runs at most once per run. */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    seq: integer("seq").notNull(),
    nodeId: text("node_id").notNull(),
    nodeType: text("node_type").notNull(),
    status: stepStatus("status").notNull(),
    port: text("port"),
    output: jsonb("output"),
    /** Plain-language account of what the node decided and why. */
    explanation: text("explanation"),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [uniqueIndex("run_steps_node_uq").on(t.runId, t.nodeId), uniqueIndex("run_steps_seq_uq").on(t.runId, t.seq)],
);

export const approvalStatus = pgEnum("approval_status", ["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text("node_id").notNull(),
    status: approvalStatus("status").notNull().default("PENDING"),
    reason: text("reason").notNull(),
    /** Snapshot shown to the approver: amount, counterparty, rule results. */
    summary: jsonb("summary").notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true, precision: 3 }),
    note: text("note"),
  },
  (t) => [uniqueIndex("approvals_run_node_uq").on(t.runId, t.nodeId), index("approvals_ws_status_idx").on(t.workspaceId, t.status)],
);
