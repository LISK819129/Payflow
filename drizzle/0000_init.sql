CREATE TYPE "public"."provenance" AS ENUM('REAL_PAYPAL_SANDBOX', 'SIMULATED', 'AI_GENERATED', 'USER_PROVIDED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'APPROVER', 'VIEWER');--> statement-breakpoint
CREATE TABLE "audit_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_id" uuid,
	"run_id" uuid,
	"paypal_ref" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"summary" text,
	"transmission_id" text,
	"verification" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"raw" jsonb NOT NULL,
	"deliveries" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_delivery_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'VIEWER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_events" ADD CONSTRAINT "paypal_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_ws_seq_uq" ON "audit_records" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "audit_run_idx" ON "audit_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_workflow_idx" ON "audit_records" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "audit_paypal_ref_idx" ON "audit_records" USING btree ("paypal_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_events_event_id_uq" ON "paypal_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "paypal_events_ws_received_idx" ON "paypal_events" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "paypal_events_resource_idx" ON "paypal_events" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));