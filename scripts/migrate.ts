import "./load-env";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "../src/server/db/client";
import { boss, ensureQueues, stopBoss } from "../src/server/jobs/boss";

async function main() {
  const { rows } = await db().execute<{ enc: string }>(sql`select pg_encoding_to_char(encoding) as enc from pg_database where datname = current_database()`);
  if (rows[0]?.enc !== "UTF8") throw new Error(`Database encoding is ${rows[0]?.enc}; PayFlow requires UTF8`);
  await migrate(db(), { migrationsFolder: "./drizzle" });
  console.log("[migrate] app schema up to date");
  // pg-boss owns its own schema; create it and our queues here so web processes never need to.
  await ensureQueues(await boss("migrate"));
  console.log("[migrate] job queues ready");
  await stopBoss();
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
