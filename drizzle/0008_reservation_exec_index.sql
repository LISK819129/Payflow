DROP INDEX "budget_reservations_exec_uq";--> statement-breakpoint
CREATE INDEX "budget_reservations_exec_idx" ON "budget_reservations" USING btree ("execution_id");