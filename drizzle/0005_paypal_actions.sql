CREATE TYPE "public"."action_status" AS ENUM('PREPARED', 'SUBMITTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "action_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "action_status" DEFAULT 'PREPARED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"amount_value" text,
	"currency" text,
	"counterparty" text,
	"target_ref" text,
	"intent" jsonb NOT NULL,
	"authorization" jsonb NOT NULL,
	"executor" text NOT NULL,
	"paypal_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"paypal_status" text,
	"result" jsonb,
	"debug_id" text,
	"error" jsonb,
	"provenance" "provenance" NOT NULL,
	"prepared_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"confirmed_by_event_id" text,
	"confirmed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"invoice_id" text NOT NULL,
	"invoice_status" text NOT NULL,
	"invoice_amount" text NOT NULL,
	"payment_amount" text NOT NULL,
	"currency" text NOT NULL,
	"payment_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_executions_key_uq" ON "action_executions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "action_executions_run_idx" ON "action_executions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "action_executions_ws_idx" ON "action_executions" USING btree ("workspace_id","prepared_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliations_invoice_run_uq" ON "reconciliations" USING btree ("invoice_id","run_id");