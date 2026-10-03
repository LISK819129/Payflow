import "./load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "../src/server/db/client";

async function main() {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  console.log("[migrate] up to date");
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
