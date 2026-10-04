CREATE TYPE "public"."analysis_status" AS ENUM('PENDING', 'OK', 'FAILED');--> statement-breakpoint
CREATE TABLE "ai_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task" text NOT NULL,
	"cache_key" text NOT NULL,
	"status" "analysis_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"provider" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"schema_name" text NOT NULL,
	"input_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"output" jsonb,
	"validation" jsonb,
	"usage" jsonb,
	"cost_usd" text,
	"error" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp (3) with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "authorities" ADD COLUMN "purpose_scope" text;--> statement-breakpoint
ALTER TABLE "authorities" ADD COLUMN "intelligence_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_analyses_cache_uq" ON "ai_analyses" USING btree ("workspace_id","cache_key");--> statement-breakpoint
CREATE INDEX "ai_analyses_task_idx" ON "ai_analyses" USING btree ("task","created_at");