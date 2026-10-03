import { PgBoss } from "pg-boss";
import { env } from "../config/env";

export const QUEUES = {
  /** A verified PayPal event waiting to be matched to workflows. */
  paypalEventRoute: "paypal-event-route",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type JobPayloads = {
  [QUEUES.paypalEventRoute]: { paypalEventId: string };
};

const g = globalThis as unknown as { __boss?: Promise<PgBoss> };

/**
 * Web processes only enqueue (often inside a business transaction via
 * `fromDrizzle`), so they skip maintenance and scheduling. The worker and the
 * migrate script own schema creation and supervision.
 */
export function boss(role: "web" | "worker" | "migrate" = "web"): Promise<PgBoss> {
  g.__boss ??= (async () => {
    const b = new PgBoss({
      connectionString: env().DATABASE_URL,
      migrate: role !== "web",
      supervise: role === "worker",
      schedule: role === "worker",
    });
    b.on("error", (err) => console.error("[pg-boss]", err));
    await b.start();
    return b;
  })();
  return g.__boss;
}

export async function ensureQueues(b: PgBoss) {
  for (const name of Object.values(QUEUES)) {
    await b.createQueue(name, { retryLimit: 5, retryBackoff: true, retryDelay: 5 });
  }
}

export async function stopBoss() {
  const b = await g.__boss;
  await b?.stop({ graceful: true });
  g.__boss = undefined;
}
