CREATE TYPE "public"."compilation_kind" AS ENUM('COMPILE', 'PATCH');--> statement-breakpoint
CREATE TYPE "public"."compilation_status" AS ENUM('COMPILED', 'NEEDS_CLARIFICATION', 'UNSUPPORTED', 'INVALID', 'FAILED', 'PROPOSED', 'APPLIED', 'DISCARDED');--> statement-breakpoint
CREATE TABLE "ai_compilations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "compilation_kind" NOT NULL,
	"status" "compilation_status" NOT NULL,
	"instruction" text NOT NULL,
	"workflow_id" uuid,
	"base_version_id" uuid,
	"result_version_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"output" jsonb,
	"graph" jsonb,
	"validation" jsonb,
	"grounding" jsonb,
	"changes" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"request_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" text DEFAULT '0' NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "ai_compilations" ADD CONSTRAINT "ai_compilations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_compilations" ADD CONSTRAINT "ai_compilations_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_compilations" ADD CONSTRAINT "ai_compilations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_compilations_ws_idx" ON "ai_compilations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ai_usage" USING btree ("at");