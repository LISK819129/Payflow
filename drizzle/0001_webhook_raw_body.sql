ALTER TABLE "paypal_events" ADD COLUMN "raw_body" text;--> statement-breakpoint
ALTER TABLE "paypal_events" ADD COLUMN "signature" jsonb;