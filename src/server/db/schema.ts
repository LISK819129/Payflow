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
