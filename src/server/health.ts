import { readFileSync } from "node:fs";
import path from "node:path";
import { desc, sql } from "drizzle-orm";
import { env, integrationStatus } from "./config/env";
import { db } from "./db/client";
import { workerHeartbeats } from "./db/schema";

/**
 * Health for the hosting platform. Liveness says the process answers;
 * readiness says it can serve: database reachable, schema migrated, and which
 * integrations are configured. Only booleans and states leave this module —
 * never connection strings, hosts, keys, ids or error text from dependencies.
 */
export type Readiness = {
  status: "ready" | "not_ready";
  checks: {
    database: "ok" | "unreachable";
    migrations: "current" | "pending" | "unknown";
    paypal: "configured" | "missing";
    paypalWebhook: "configured" | "missing";
    ai: "configured" | "missing";
    worker: "recent" | "not_seen";
  };
  environment: "sandbox";
  time: string;
};

function expectedMigrations(): number | null {
  try {
    const j = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    return j.entries.length;
  } catch {
    return null;
  }
}

export async function readiness(): Promise<Readiness> {
  const status = integrationStatus();
  let database: Readiness["checks"]["database"] = "ok";
  let migrations: Readiness["checks"]["migrations"] = "unknown";
  let worker: Readiness["checks"]["worker"] = "not_seen";
  try {
    await db().execute(sql`select 1`);
    const expected = expectedMigrations();
    const { rows } = await db().execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    if (expected !== null) migrations = (rows[0]?.n ?? 0) >= expected ? "current" : "pending";
    const [hb] = await db().select({ at: workerHeartbeats.lastSeenAt }).from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt)).limit(1);
    worker = hb && Date.now() - hb.at.getTime() < 5 * 60_000 ? "recent" : "not_seen";
  } catch {
    database = "unreachable";
  }
  const ready = database === "ok" && migrations !== "pending";
  return {
    status: ready ? "ready" : "not_ready",
    checks: {
      database,
      migrations,
      paypal: status.paypal.configured ? "configured" : "missing",
      paypalWebhook: status.paypalWebhooks.configured ? "configured" : "missing",
      ai: status.ai.configured ? "configured" : "missing",
      worker,
    },
    environment: env().PAYPAL_ENV === "sandbox" ? "sandbox" : (() => { throw new Error("unreachable: live PayPal is refused at boot"); })(),
    time: new Date().toISOString(),
  };
}
