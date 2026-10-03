import "./load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "../src/server/db/client";
import { boss, ensureQueues, stopBoss } from "../src/server/jobs/boss";

async function main() {
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
