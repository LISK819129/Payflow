import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; modules accept either. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DbOrTx = DB | Tx;

// Next dev re-evaluates modules on change; keep one pool per process.
const g = globalThis as unknown as { __payflowPool?: Pool; __payflowDb?: DB };

export function pool(): Pool {
  if (!g.__payflowPool) {
    g.__payflowPool = new Pool({ connectionString: env().DATABASE_URL, max: 10 });
  }
  return g.__payflowPool;
}

export function db(): DB {
  if (!g.__payflowDb) {
    g.__payflowDb = drizzle(pool(), { schema });
  }
  return g.__payflowDb;
}

export async function closeDb() {
  await g.__payflowPool?.end();
  g.__payflowPool = undefined;
  g.__payflowDb = undefined;
}

export { schema };
