/**
 * PayFlow worker: consumes pg-boss queues. Runs as a separate process
 * (`pnpm worker` locally, a Render background worker in deployment).
 */
import "../../scripts/load-env";
import { closeDb } from "../server/db/client";
import { QUEUES, boss, ensureQueues, stopBoss, type JobPayloads } from "../server/jobs/boss";
import { paypal } from "../server/paypal/client";
import { routePayPalEvent } from "../server/webhooks/route-event";
import { runtimeDeps } from "../server/workflow/runtime/deps";
import { advanceRun, dueTimers } from "../server/workflow/runtime/engine";
import { onScheduleTick } from "../server/workflow/schedule";

async function main() {
  const b = await boss("worker");
  await ensureQueues(b);

  await b.work<JobPayloads[typeof QUEUES.paypalEventRoute]>(QUEUES.paypalEventRoute, async ([job]) => {
    const result = await routePayPalEvent(job.data.paypalEventId, paypal(), runtimeDeps);
    console.log(`[worker] ${QUEUES.paypalEventRoute} ${job.id}`, JSON.stringify(result));
  });

  await b.work<JobPayloads[typeof QUEUES.runAdvance]>(QUEUES.runAdvance, { batchSize: 5 }, async (jobs) => {
    for (const job of jobs) {
      const status = await advanceRun(job.data.runId, runtimeDeps);
      console.log(`[worker] ${QUEUES.runAdvance} run=${job.data.runId} → ${status}`);
    }
  });

  await b.work<JobPayloads[typeof QUEUES.workflowSchedule]>(QUEUES.workflowSchedule, async ([job]) => {
    const r = await onScheduleTick(job.data.workflowId, runtimeDeps);
    console.log(`[worker] ${QUEUES.workflowSchedule} workflow=${job.data.workflowId}`, JSON.stringify(r));
  });

  // Safety net for delayed advance jobs: every minute, wake any timer that is due.
  await b.schedule(QUEUES.timerSweep, "* * * * *", {});
  await b.work(QUEUES.timerSweep, async () => {
    for (const r of await dueTimers(new Date())) await runtimeDeps.enqueueAdvance(r.id);
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
