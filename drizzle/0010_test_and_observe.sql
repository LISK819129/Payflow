CREATE TYPE "public"."simulation_mode" AS ENUM('TEST', 'OBSERVE');--> statement-breakpoint
CREATE TABLE "simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mode" "simulation_mode" NOT NULL,
	"input_provenance" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"graph_hash" text NOT NULL,
	"authorities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paypal_event_id" text,
	"trigger" jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" text NOT NULL,
	"headline" text NOT NULL,
	"would_action" jsonb,
	"authority_decision" jsonb,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_at" timestamp (3) with time zone NOT NULL,
	"external_actions_disabled" boolean DEFAULT true NOT NULL,
	"duration_ms" integer,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "observing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "observing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "simulations_workflow_idx" ON "simulations" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "simulations_observation_uq" ON "simulations" USING btree ("workflow_id","graph_hash","paypal_event_id");