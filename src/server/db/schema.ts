import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
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

// ── AI ────────────────────────────────────────────────────────────────────────

export const compilationKind = pgEnum("compilation_kind", ["COMPILE", "PATCH"]);
export const compilationStatus = pgEnum("compilation_status", [
  "COMPILED",
  "NEEDS_CLARIFICATION",
  "UNSUPPORTED",
  "INVALID",
  "FAILED",
  "PROPOSED",
  "APPLIED",
  "DISCARDED",
]);

/**
 * Provenance for every AI compilation or edit: the instruction, the provider
 * and model, the structured output it returned (never chain-of-thought), what
 * PayFlow's deterministic checks concluded, and what the user did with it.
 */
export const aiCompilations = pgTable(
  "ai_compilations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: compilationKind("kind").notNull(),
    status: compilationStatus("status").notNull(),
    instruction: text("instruction").notNull(),
    workflowId: uuid("workflow_id").references(() => workflows.id),
    /** Version the patch was proposed against / the draft version created. */
    baseVersionId: uuid("base_version_id"),
    resultVersionId: uuid("result_version_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** The structured output the model returned (final attempt). */
    output: jsonb("output"),
    graph: jsonb("graph"),
    validation: jsonb("validation"),
    grounding: jsonb("grounding"),
    changes: jsonb("changes"),
    attempts: integer("attempts").notNull().default(1),
    /** Why each rejected attempt was rejected (validator / parser objections), in order. */
    repairs: jsonb("repairs"),
    error: jsonb("error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("ai_compilations_ws_idx").on(t.workspaceId, t.createdAt)],
);

/** One row per real model call, for the hard budget and the Settings spend view. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").notNull(),
    requestId: text("request_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** USD, computed from the published per-token prices at call time. */
    costUsd: text("cost_usd").notNull().default("0"),
    ok: boolean("ok").notNull(),
    error: text("error"),
  },
  (t) => [index("ai_usage_at_idx").on(t.at)],
);

// ── PayPal actions (Phase 5) ─────────────────────────────────────────────────

export const actionStatus = pgEnum("action_status", ["PREPARED", "SUBMITTING", "SUCCEEDED", "FAILED", "UNKNOWN"]);

/**
 * One row per external action a run performs (refund, payout, invoice, capture…).
 * Written PREPARED inside the step transaction before any network call; the
 * call itself happens outside the transaction under a lease, keyed by
 * `idempotencyKey` (sent to PayPal as PayPal-Request-Id). A crash, retry or
 * duplicate job can only ever replay the same request.
 */
export const actionExecutions = pgTable(
  "action_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text("node_id").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: actionStatus("status").notNull().default("PREPARED"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** Exact decimal string and explicit currency, as sent. */
    amountValue: text("amount_value"),
    currency: text("currency"),
    counterparty: text("counterparty"),
    /** The PayPal object acted upon (capture/order/invoice id). */
    targetRef: text("target_ref"),
    /** Safe summary of what will be sent (no credentials). */
    intent: jsonb("intent").notNull(),
    /** Gates passed on the executed path that authorise this action. */
    authorization: jsonb("authorization").notNull(),
    executor: text("executor").notNull(),
    /** PayPal ids created or touched, for linking webhooks back. */
    paypalRefs: text("paypal_refs").array().notNull().default(sql`'{}'::text[]`),
    paypalStatus: text("paypal_status"),
    result: jsonb("result"),
    debugId: text("debug_id"),
    error: jsonb("error"),
    provenance: provenance("provenance").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, precision: 3 }),
    completedAt: timestamp("completed_at", { withTimezone: true, precision: 3 }),
    confirmedByEventId: text("confirmed_by_event_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, precision: 3 }),
    /** The latest PayPal webhook about this action and the status it reported (e.g. a payout item going UNCLAIMED). */
    lastEventType: text("last_event_type"),
    lastEventStatus: text("last_event_status"),
    /** Phase 6: the authority decision that permitted this action, and its budget reservation. */
    authorityId: uuid("authority_id"),
    decisionId: uuid("decision_id"),
  },
  (t) => [
    uniqueIndex("action_executions_key_uq").on(t.idempotencyKey),
    index("action_executions_run_idx").on(t.runId),
    index("action_executions_ws_idx").on(t.workspaceId, t.preparedAt),
  ],
);

/** PayFlow's ledger entry: a PayPal invoice settled by a specific payment. */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    invoiceId: text("invoice_id").notNull(),
    invoiceStatus: text("invoice_status").notNull(),
    invoiceAmount: text("invoice_amount").notNull(),
    paymentAmount: text("payment_amount").notNull(),
    currency: text("currency").notNull(),
    paymentRef: text("payment_ref"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reconciliations_invoice_run_uq").on(t.invoiceId, t.runId)],
);

// ── Financial authority (Phase 6) ───────────────────────────────────────────

export const authorityStatus = pgEnum("authority_status", ["ACTIVE", "SUSPENDED", "REVOKED"]);

/**
 * Delegated financial authority: WHO (workflows) may do WHAT (PayPal action
 * kinds), to WHOM (counterparties), for HOW MUCH (per transaction, per period),
 * HOW OFTEN (count per period), UNTIL WHEN (validity window). Every protected
 * PayPal action must be covered by exactly one ACTIVE authority, or a person
 * decides. Each edit bumps `version` and is audited.
 */
export const authorities = pgTable(
  "authorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description"),
    status: authorityStatus("status").notNull().default("ACTIVE"),
    statusReason: text("status_reason"),
    workflowIds: jsonb("workflow_ids").$type<string[]>().notNull().default([]),
    actions: jsonb("actions").$type<string[]>().notNull().default([]),
    /** "allowlist": only listed counterparties; "any": any counterparty not denied. */
    counterpartyRule: text("counterparty_rule").$type<"allowlist" | "any">().notNull().default("allowlist"),
    counterparties: jsonb("counterparties").$type<{ id: string; name?: string }[]>().notNull().default([]),
    deniedCounterparties: jsonb("denied_counterparties").$type<{ id: string; name?: string }[]>().notNull().default([]),
    /** Permitted currencies; amount limits are expressed in the first one (no FX). */
    currencies: jsonb("currencies").$type<string[]>().notNull().default(["USD"]),
    perTransactionMax: numeric("per_transaction_max", { precision: 16, scale: 2 }),
    budgetAmount: numeric("budget_amount", { precision: 16, scale: 2 }),
    budgetPeriod: text("budget_period").$type<"day" | "week" | "month">(),
    maxCount: integer("max_count"),
    countPeriod: text("count_period").$type<"hour" | "day" | "week" | "month">(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    /** Phase 7: what the money may be FOR, in plain words; AI classifies requests against it (evidence only). */
    purposeScope: text("purpose_scope"),
    /** Phase 7: what each kind of AI evidence causes. Deterministic; the AI never chooses this. */
    intelligencePolicy: jsonb("intelligence_policy").$type<Record<string, string>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("authorities_ws_idx").on(t.workspaceId)],
);

export const reservationStatus = pgEnum("reservation_status", ["RESERVED", "COMMITTED", "RELEASED"]);

/**
 * Budget and frequency ledger. A reservation counts against its scope from the
 * moment it is RESERVED (so concurrent requests see it), becomes COMMITTED when
 * PayPal confirms the action, and is RELEASED when the action definitively did
 * not happen. An unknown outcome keeps it RESERVED: fail closed.
 */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** authority:<id> · budget:<key> · frequency:<key> */
    scopeKey: text("scope_key").notNull(),
    /** Calendar period in UTC: 2026-10 · 2026-W40 · 2026-10-04 · 2026-10-04T09 */
    periodKey: text("period_key").notNull(),
    authorityId: uuid("authority_id"),
    amount: numeric("amount", { precision: 16, scale: 2 }),
    currency: text("currency"),
    status: reservationStatus("status").notNull().default("RESERVED"),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text("node_id").notNull(),
    executionId: uuid("execution_id"),
    decisionId: uuid("decision_id"),
    /** A person approved this request although it exceeded a limit. */
    override: boolean("override").notNull().default(false),
    approvalId: uuid("approval_id"),
    createdAt: createdAt(),
    settledAt: timestamp("settled_at", { withTimezone: true, precision: 3 }),
    settleReason: text("settle_reason"),
  },
  (t) => [
    uniqueIndex("budget_reservations_scope_uq").on(t.runId, t.nodeId, t.scopeKey),
    index("budget_reservations_exec_idx").on(t.executionId),
    index("budget_reservations_usage_idx").on(t.scopeKey, t.periodKey, t.status),
  ],
);

export const authorityDecisionKind = pgEnum("authority_decision", ["ALLOW", "REVIEW", "DENY"]);

/** Every authority evaluation, with enough detail to reconstruct it. No secrets. */
export const authorityDecisions = pgTable(
  "authority_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text("node_id").notNull(),
    workflowId: uuid("workflow_id").notNull(),
    versionId: uuid("version_id").notNull(),
    /** Who decided: "payflow-internal" today; an external authority service later. */
    provider: text("provider").notNull(),
    authorityId: uuid("authority_id"),
    authorityVersion: integer("authority_version"),
    authoritySnapshot: jsonb("authority_snapshot"),
    request: jsonb("request").notNull(),
    evaluations: jsonb("evaluations").notNull(),
    budget: jsonb("budget"),
    frequency: jsonb("frequency"),
    decision: authorityDecisionKind("decision").notNull(),
    /** The person's approval this evaluation relied on, when it overrides a REVIEW. */
    approvalId: uuid("approval_id"),
    /** ALLOW · ALLOW_AFTER_HUMAN_APPROVAL · REVIEW · DENY */
    outcome: text("outcome").notNull(),
    reservationId: uuid("reservation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("authority_decisions_run_idx").on(t.runId), index("authority_decisions_authority_idx").on(t.authorityId, t.createdAt)],
);

// ── Development: worker versions ────────────────────────────────────────────

/** One row per worker process, so a stale worker running old code is visible and stops itself. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  host: text("host").notNull(),
  pid: integer("pid").notNull(),
  commit: text("commit"),
  dirty: boolean("dirty").notNull().default(false),
  sourceHash: text("source_hash").notNull(),
  status: text("status").$type<"RUNNING" | "STOPPED">().notNull().default("RUNNING"),
  stopReason: text("stop_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── AI financial intelligence (Phase 7) ─────────────────────────────────────

export const analysisStatus = pgEnum("analysis_status", ["PENDING", "OK", "FAILED"]);

/**
 * One execution-time AI analysis, content-addressed: the same task, prompt and
 * schema version, model and exact inputs share one row, so a repeat is a cache
 * hit, not a second paid call. Holds the provenance (provider, model, prompt
 * hash, input hashes, validated output, usage, cost) — never chain-of-thought,
 * never credentials. Authority decisions are never cached; they read this.
 */
export const aiAnalyses = pgTable(
  "ai_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    task: text("task").notNull(),
    cacheKey: text("cache_key").notNull(),
    status: analysisStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true, precision: 3 }),
    provider: text("provider"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    schemaName: text("schema_name").notNull(),
    inputHash: text("input_hash").notNull(),
    /** Trusted context sent to the model and the hash of every untrusted document (not the documents). */
    request: jsonb("request").notNull(),
    output: jsonb("output"),
    validation: jsonb("validation"),
    usage: jsonb("usage"),
    costUsd: text("cost_usd"),
    error: text("error"),
    hits: integer("hits").notNull().default(0),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [uniqueIndex("ai_analyses_cache_uq").on(t.workspaceId, t.cacheKey), index("ai_analyses_task_idx").on(t.task, t.createdAt)],
);
