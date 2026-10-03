CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('RUNNING', 'WAITING_APPROVAL', 'WAITING_TIMER', 'SUSPENDED', 'COMPLETED', 'BLOCKED', 'REJECTED', 'NEEDS_REVIEW', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('OK', 'ERROR', 'WAITING');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('DRAFT', 'VALIDATING', 'SIMULATING', 'AWAITING_APPROVAL', 'ACTIVE', 'PAUSED', 'FROZEN', 'COMPLETED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"requested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp (3) with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"status" "step_status" NOT NULL,
	"port" text,
	"output" jsonb,
	"explanation" text,
	"error" jsonb,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'RUNNING' NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_ref" text NOT NULL,
	"trigger_payload" jsonb NOT NULL,
	"provenance" "provenance" NOT NULL,
	"current_node_id" text,
	"wake_at" timestamp with time zone,
	"outcome" text,
	"started_by" uuid,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'DRAFT' NOT NULL,
	"graph" jsonb NOT NULL,
	"graph_hash" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"compile_meta" jsonb,
	"validation" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" uuid,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" "workflow_state" DEFAULT 'DRAFT' NOT NULL,
	"active_version_id" uuid,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frozen_reason" text,
	"frozen_at" timestamp with time zone,
	"frozen_by_run_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_run_node_uq" ON "approvals" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "approvals_ws_status_idx" ON "approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_node_uq" ON "run_steps" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_seq_uq" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_trigger_uq" ON "workflow_runs" USING btree ("version_id","trigger_ref");--> statement-breakpoint
CREATE INDEX "workflow_runs_ws_idx" ON "workflow_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_idx" ON "workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_uq" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflows_ws_idx" ON "workflows" USING btree ("workspace_id");