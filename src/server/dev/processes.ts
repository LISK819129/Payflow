import { PROJECT_ROOT } from "./version";

const norm = (s: string) => s.replaceAll("\\", "/").toLowerCase();

/**
 * A PayFlow worker of THIS checkout: its command line must contain both this
 * project's path and the worker entry. Anything else is never touched.
 */
export function isPayflowWorker(cmd: string, root = PROJECT_ROOT): boolean {
  const c = norm(cmd);
  const r = norm(root).replace(/\/+$/, "");
  const fileUrlRoot = `file:///${r.replace(/^\//, "")}`;
  return (c.includes(r + "/") || c.includes(fileUrlRoot + "/")) && c.includes("src/worker/index.ts") && !c.includes("worker-control");
}
