CREATE TYPE "public"."authority_decision" AS ENUM('ALLOW', 'REVIEW', 'DENY');--> statement-breakpoint
CREATE TYPE "public"."authority_status" AS ENUM('ACTIVE', 'SUSPENDED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('RESERVED', 'COMMITTED', 'RELEASED');--> statement-breakpoint
CREATE TABLE "authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "authority_status" DEFAULT 'ACTIVE' NOT NULL,
	"status_reason" text,
	"workflow_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counterparty_rule" text DEFAULT 'allowlist' NOT NULL,
	"counterparties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_counterparties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currencies" jsonb DEFAULT '["USD"]'::jsonb NOT NULL,
	"per_transaction_max" numeric(16, 2),
	"budget_amount" numeric(16, 2),
	"budget_period" text,
	"max_count" integer,
	"count_period" text,
	"valid_from" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authority_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"authority_id" uuid,
	"authority_version" integer,
	"authority_snapshot" jsonb,
	"request" jsonb NOT NULL,
	"evaluations" jsonb NOT NULL,
	"budget" jsonb,
	"frequency" jsonb,
	"decision" "authority_decision" NOT NULL,
	"approval_id" uuid,
	"outcome" text NOT NULL,
	"reservation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"period_key" text NOT NULL,
	"authority_id" uuid,
	"amount" numeric(16, 2),
	"currency" text,
	"status" "reservation_status" DEFAULT 'RESERVED' NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"execution_id" uuid,
	"decision_id" uuid,
	"override" boolean DEFAULT false NOT NULL,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp (3) with time zone,
	"settle_reason" text
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"commit" text,
	"dirty" boolean DEFAULT false NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"stop_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD COLUMN "authority_id" uuid;--> statement-breakpoint
ALTER TABLE "action_executions" ADD COLUMN "decision_id" uuid;--> statement-breakpoint
ALTER TABLE "authorities" ADD CONSTRAINT "authorities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorities" ADD CONSTRAINT "authorities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_decisions" ADD CONSTRAINT "authority_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_decisions" ADD CONSTRAINT "authority_decisions_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorities_ws_idx" ON "authorities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "authority_decisions_run_idx" ON "authority_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "authority_decisions_authority_idx" ON "authority_decisions" USING btree ("authority_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_scope_uq" ON "budget_reservations" USING btree ("run_id","node_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_exec_uq" ON "budget_reservations" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_usage_idx" ON "budget_reservations" USING btree ("scope_key","period_key","status");