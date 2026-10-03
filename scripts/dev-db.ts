/**
 * Local development Postgres: real PostgreSQL binaries via `embedded-postgres`,
 * data kept in ./.data/pg. Production uses Render Postgres; nothing in the app
 * knows the difference, it only sees DATABASE_URL.
 *
 *   pnpm db:start   # leaves the server running in the foreground
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const PORT = Number(process.env.PAYFLOW_PG_PORT ?? 54329);
const dataDir = path.resolve(".data/pg");
const user = "payflow";
const password = "payflow-local-dev";

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port: PORT,
    persistent: true,
    // Windows initdb defaults to WIN1252; PayFlow stores arbitrary Unicode (names, notes, arrows).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (m) => console.error("[pg]", m),
  });

  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log(`[pg] initialising cluster in ${dataDir}`);
    await pg.initialise();
  }
  await pg.start();

  for (const name of ["payflow", "payflow_test"]) {
    const c = new Client({ host: "127.0.0.1", port: PORT, user, password, database: "postgres" });
    await c.connect();
    const r = await c.query<{ enc: string }>(
      "select pg_encoding_to_char(encoding) as enc from pg_database where datname = $1",
      [name],
    );
    if (r.rowCount === 0) {
      await c.query(`create database ${name} with encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
      console.log(`[pg] created database ${name} (UTF8)`);
    } else if (r.rows[0].enc !== "UTF8") {
      await c.end();
      throw new Error(`database ${name} uses ${r.rows[0].enc}, not UTF8. Rename it and rerun to recreate it as UTF8.`);
    }
    await c.end();
  }

  console.log(`[pg] ready on postgres://${user}:***@127.0.0.1:${PORT}/payflow`);

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
