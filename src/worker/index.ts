/**
 * PayFlow worker: consumes pg-boss queues. Runs as a separate process
 * (`pnpm worker` locally, a Render background worker in deployment).
 *
 * It never runs stale code: it records the commit and source hash it started
 * with, and before every job checks that the source on disk is unchanged. If it
 * changed, the job is handed back to the queue for a fresh worker and this one
 * exits. Start a fresh one with `pnpm worker:fresh` (stops old PayFlow workers first).
 */
import "../../scripts/load-env";
import { hostname } from "node:os";
import { and, eq, gt, ne } from "drizzle-orm";
import { closeDb, db } from "../server/db/client";
import { workerHeartbeats } from "../server/db/schema";
import { gitInfo, sourceFingerprint, sourceHash } from "../server/dev/version";
import { QUEUES, boss, ensureQueues, stopBoss, type JobPayloads, type QueueName } from "../server/jobs/boss";
import { paypal } from "../server/paypal/client";
import { routePayPalEvent } from "../server/webhooks/route-event";
import { runtimeDeps } from "../server/workflow/runtime/deps";
import { advanceRun, dueTimers } from "../server/workflow/runtime/engine";
import { onScheduleTick } from "../server/workflow/schedule";
import { observeEvent } from "../server/simulation/run";
import { syncAgentRequestForRun } from "../server/agents/status";

const ID = `${hostname()}:${process.pid}`;
const version = { ...gitInfo(), sourceHash: sourceHash() };
const startedFingerprint = sourceFingerprint();
const watchSource = process.env.PAYFLOW_WORKER_WATCH !== "0";
let stopping = false;

async function heartbeat(status: "RUNNING" | "STOPPED" = "RUNNING", stopReason?: string) {
  await db()
    .insert(workerHeartbeats)
    .values({ id: ID, host: hostname(), pid: process.pid, commit: version.commit, dirty: version.dirty, sourceHash: version.sourceHash, status, stopReason: stopReason ?? null })
    .onConflictDoUpdate({ target: workerHeartbeats.id, set: { lastSeenAt: new Date(), status, stopReason: stopReason ?? null } });
}

/** True when the code on disk is no longer the code this process loaded. */
function stale(): boolean {
  return watchSource && sourceFingerprint() !== startedFingerprint && sourceHash() !== version.sourceHash;
}

async function shutdown(reason: string, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] shutting down: ${reason}`);
  await heartbeat("STOPPED", reason).catch(() => {});
  await stopBoss();
  await closeDb();
  process.exit(code);
}

/**
 * Runs a job only if this worker's code is current; otherwise re-queues the same
 * payload for a fresh worker (so nothing is lost or retried away) and exits.
 */
function guarded<T extends object>(queue: QueueName, fn: (data: T) => Promise<void>) {
  return async (data: T) => {
    if (stopping || stale()) {
      const b = await boss("worker");
      await b.send(queue, data, { startAfter: 15 });
      console.warn(`[worker] STALE: source changed since this worker started (${version.sourceHash}); ${queue} job handed back for a fresh worker`);
      void shutdown("source changed since start (stale code)", 75);
      return;
    }
    await fn(data);
  };
}

async function main() {
  console.log(`[worker] PayFlow worker ${ID} · commit ${version.commit ?? "unknown"}${version.dirty ? " (uncommitted changes)" : ""} · source ${version.sourceHash}`);
  await heartbeat();
  const others = await db()
    .select()
    .from(workerHeartbeats)
    .where(and(eq(workerHeartbeats.status, "RUNNING"), ne(workerHeartbeats.id, ID), gt(workerHeartbeats.lastSeenAt, new Date(Date.now() - 60_000))));
  for (const o of others) {
    const same = o.sourceHash === version.sourceHash;
    console.warn(`[worker] another PayFlow worker is running: ${o.id} · source ${o.sourceHash}${same ? " (same code)" : " — DIFFERENT code; it stops itself before its next job, or run pnpm worker:stop"}`);
  }

  const b = await boss("worker");
  await ensureQueues(b);

  const routeEvent = guarded<JobPayloads[typeof QUEUES.paypalEventRoute]>(QUEUES.paypalEventRoute, async (data) => {
    const result = await routePayPalEvent(data.paypalEventId, paypal(), runtimeDeps);
    console.log(`[worker] ${QUEUES.paypalEventRoute}`, JSON.stringify(result));
    // After live routing, offer the event to observing drafts. Separate job: it can never delay or fail live routing.
    if ("routed" in result && result.routed) await (await boss("worker")).send(QUEUES.observeEvent, { paypalEventId: data.paypalEventId });
  });
  await b.work<JobPayloads[typeof QUEUES.paypalEventRoute]>(QUEUES.paypalEventRoute, async ([job]) => routeEvent(job.data));

  const advance = guarded<JobPayloads[typeof QUEUES.runAdvance]>(QUEUES.runAdvance, async (data) => {
    const status = await advanceRun(data.runId, runtimeDeps);
    console.log(`[worker] ${QUEUES.runAdvance} run=${data.runId} → ${status}`);
    // Agent-started runs: keep the agent's view and its Intent Receipt chain current.
    await syncAgentRequestForRun(data.runId);
  });
  await b.work<JobPayloads[typeof QUEUES.runAdvance]>(QUEUES.runAdvance, { batchSize: 5 }, async (jobs) => {
    for (const job of jobs) await advance(job.data);
  });

  const schedule = guarded<JobPayloads[typeof QUEUES.workflowSchedule]>(QUEUES.workflowSchedule, async (data) => {
    const r = await onScheduleTick(data.workflowId, runtimeDeps);
    console.log(`[worker] ${QUEUES.workflowSchedule} workflow=${data.workflowId}`, JSON.stringify(r));
  });
  await b.work<JobPayloads[typeof QUEUES.workflowSchedule]>(QUEUES.workflowSchedule, async ([job]) => schedule(job.data));

  const observe = guarded<JobPayloads[typeof QUEUES.observeEvent]>(QUEUES.observeEvent, async (data) => {
    const r = await observeEvent(data.paypalEventId);
    console.log(`[worker] ${QUEUES.observeEvent} event=${data.paypalEventId} observations=${r.length}`, JSON.stringify(r));
  });
  await b.work<JobPayloads[typeof QUEUES.observeEvent]>(QUEUES.observeEvent, async ([job]) => observe(job.data));

  // Safety net for delayed advance jobs: every minute, wake any timer that is due.
  await b.schedule(QUEUES.timerSweep, "* * * * *", {});
  await b.work(QUEUES.timerSweep, async () => {
    if (stopping || stale()) return;
    for (const r of await dueTimers(new Date())) await runtimeDeps.enqueueAdvance(r.id);
  });

  console.log("[worker] listening on", Object.values(QUEUES).join(", "));

  // Heartbeat; also notices an edit while idle and exits before any job can run old code.
  setInterval(() => {
    if (stopping) return;
    if (stale()) void shutdown("source changed since start (stale code)", 75);
    else heartbeat().catch((e) => console.error("[worker] heartbeat failed", e));
  }, 15_000).unref();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  console.error("[worker] fatal", err);
  await heartbeat("STOPPED", `fatal: ${(err as Error).message}`).catch(() => {});
  await closeDb();
  process.exit(1);
});
