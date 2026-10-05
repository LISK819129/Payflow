import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Which code a PayFlow process is running. A worker records this when it
 * starts and re-checks it before every job, so code edited after it started
 * can never run silently as old code.
 */

const ROOT = process.cwd();
const WATCHED = ["src", "scripts/load-env.ts", "package.json"];

function files(): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) if (f !== "node_modules" && !f.startsWith(".")) walk(path.join(p, f));
    } else if (/\.(ts|tsx|json)$/.test(p)) out.push(p);
  };
  for (const w of WATCHED) walk(path.join(ROOT, w));
  return out.sort();
}

/** Content hash of the source the server/worker runs: the version identity. */
export function sourceHash(): string {
  const h = createHash("sha256");
  for (const f of files()) h.update(path.relative(ROOT, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 12);
}

/** Cheap change detector (paths, sizes, mtimes) for the per-job check. */
export function sourceFingerprint(): string {
  const h = createHash("sha256");
  for (const f of files()) {
    const st = statSync(f);
    h.update(`${path.relative(ROOT, f)}|${st.size}|${st.mtimeMs}\n`);
  }
  return h.digest("hex");
}

export function gitInfo(): { commit: string | null; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ...WATCHED], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { commit, dirty };
  } catch {
    // On Render the checkout may have no git metadata; Render provides the deployed commit.
    const deployed = process.env.PAYFLOW_COMMIT ?? process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null;
    return { commit: deployed, dirty: false };
  }
}

export const PROJECT_ROOT = ROOT;
