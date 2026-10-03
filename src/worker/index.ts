/**
 * PayFlow worker: consumes pg-boss queues. Runs as a separate process
 * (`pnpm worker` locally, a Render background worker in deployment).
 */
import "../../scripts/load-env";
import { closeDb } from "../server/db/client";
import { QUEUES, boss, ensureQueues, stopBoss, type JobPayloads } from "../server/jobs/boss";
import { paypal } from "../server/paypal/client";
import { routePayPalEvent } from "../server/webhooks/route-event";

async function main() {
  const b = await boss("worker");
  await ensureQueues(b);

  await b.work<JobPayloads[typeof QUEUES.paypalEventRoute]>(QUEUES.paypalEventRoute, async ([job]) => {
    const result = await routePayPalEvent(job.data.paypalEventId, paypal());
    console.log(`[worker] ${QUEUES.paypalEventRoute} ${job.id}`, result);
  });

  console.log("[worker] listening on", Object.values(QUEUES).join(", "));

  const shutdown = async () => {
    console.log("[worker] shutting down");
    await stopBoss();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (err) => {
  console.error("[worker] fatal", err);
  await closeDb();
  process.exit(1);
});
