import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "../db/client";
import { boss, ensureQueues, stopBoss } from "../jobs/boss";

/**
 * Brings a database to the current schema: refuses a non-UTF8 database, applies
 * the Drizzle migrations, creates the pg-boss queues. Idempotent. Used by
 * `pnpm db:migrate` (Render's pre-deploy step) and `pnpm deploy:setup`.
 */
export async function runMigrations(): Promise<{ applied: number }> {
  const { rows } = await db().execute<{ enc: string }>(sql`select pg_encoding_to_char(encoding) as enc from pg_database where datname = current_database()`);
  if (rows[0]?.enc !== "UTF8") throw new Error(`Database encoding is ${rows[0]?.enc}; PayFlow requires UTF8`);
  await migrate(db(), { migrationsFolder: "./drizzle" });
  const { rows: n } = await db().execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  // pg-boss owns its own schema; create it and our queues here so web processes never need to.
  await ensureQueues(await boss("migrate"));
  await stopBoss();
  return { applied: n[0]?.n ?? 0 };
}
