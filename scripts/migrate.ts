import "./load-env";
import { closeDb } from "../src/server/db/client";
import { runMigrations } from "../src/server/deploy/migrate";

async function main() {
  const r = await runMigrations();
  console.log(`[migrate] app schema up to date (${r.applied} migrations)`);
  console.log("[migrate] job queues ready");
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
