import { QUEUES, boss } from "../../jobs/boss";
import type { RuntimeDeps } from "./types";

/** Production runtime dependencies: pg-boss for (delayed) advancement, wall clock. */
export const runtimeDeps: RuntimeDeps = {
  async enqueueAdvance(runId, opts) {
    const b = await boss();
    await b.send(QUEUES.runAdvance, { runId }, opts?.startAfter ? { startAfter: opts.startAfter } : {});
  },
  now: () => new Date(),
};
