import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";

let migrated = false;

/** Brings the test database to the latest schema and empties every table. */
export async function resetTestDb() {
  if (!migrated) {
    await migrate(db(), { migrationsFolder: "./drizzle" });
    migrated = true;
  }
  const { rows } = await db().execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  if (rows.length > 0) {
    const list = rows.map((r) => `"${r.tablename}"`).join(", ");
    await db().execute(sql.raw(`truncate ${list} restart identity cascade`));
  }
}

export async function createWorkspace(name = "Test Workspace") {
  const [ws] = await db().insert(workspaces).values({ name }).returning();
  return ws;
}
