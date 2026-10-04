/**
 * Development tool: find and (optionally) stop PayFlow worker processes.
 *
 *   pnpm worker:status   list PayFlow workers and whether they run the current code
 *   pnpm worker:stop     stop every PayFlow worker of this checkout
 *   pnpm worker:fresh    stop them, then start one on the current code
 *
 * Only processes whose command line contains BOTH this project's path and the
 * worker entry (src/worker/index.ts) are touched. Nothing else is terminated.
 */
import "./load-env";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "../src/server/db/client";
import { workerHeartbeats } from "../src/server/db/schema";
import { isPayflowWorker } from "../src/server/dev/processes";
import { PROJECT_ROOT, sourceHash } from "../src/server/dev/version";

type Proc = { pid: number; parentPid: number; cmd: string };

function listProcesses(): Proc[] {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ).trim();
    if (!out) return [];
    const rows = JSON.parse(out) as { ProcessId: number; ParentProcessId: number; CommandLine: string | null } | { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[];
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, parentPid: r.ParentProcessId, cmd: r.CommandLine ?? "" }));
  }
  return execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), parentPid: Number(m[2]), cmd: m[3] }));
}

function stop(pid: number) {
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGTERM");
}

async function main() {
  const mode = process.argv[2] ?? "status";
  const current = sourceHash();
  const procs = listProcesses().filter((p) => p.pid !== process.pid && isPayflowWorker(p.cmd));
  // Stop only the top of each worker tree; its children go with it.
  const pids = new Set(procs.map((p) => p.pid));
  const roots = procs.filter((p) => !pids.has(p.parentPid));
  const beats = await db().select().from(workerHeartbeats).where(and(eq(workerHeartbeats.host, hostname()), eq(workerHeartbeats.status, "RUNNING")));

  console.log(`PayFlow at ${PROJECT_ROOT} · current source ${current}`);
  if (roots.length === 0) console.log("No PayFlow worker processes running.");
  for (const p of roots) {
    const tree = [p.pid, ...procs.filter((c) => c.parentPid === p.pid).map((c) => c.pid)];
    const beat = beats.find((b) => tree.includes(b.pid));
    const tag = !beat ? "version unknown (started before version tracking)" : beat.sourceHash === current ? "current code" : `STALE (source ${beat.sourceHash})`;
    console.log(`  worker pid ${p.pid} · ${tag}`);
  }

  if (mode === "stop") {
    for (const p of roots) {
      stop(p.pid);
      console.log(`  stopped PayFlow worker pid ${p.pid}`);
    }
    const stoppedPids = procs.map((p) => p.pid);
    if (stoppedPids.length) {
      await db()
        .update(workerHeartbeats)
        .set({ status: "STOPPED", stopReason: "stopped by worker:stop", lastSeenAt: new Date() })
        .where(and(eq(workerHeartbeats.host, hostname()), inArray(workerHeartbeats.pid, stoppedPids)));
    }
  }
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
