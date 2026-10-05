/**
 * Imported FIRST by the deploy commands: reads .env.deploy.local and points
 * this process at the deployed database (and the deployed demo suppliers) before any PayFlow module reads its
 * configuration (`.env.local` never overrides it).
 */
import { randomBytes } from "node:crypto";
import { JUDGE_DEPLOYMENT } from "../../src/server/deploy/config";
import { applyTarget, readTarget, type Target } from "../../src/server/deploy/target";

export const allowLocal = process.argv.includes("--allow-local");
const t = readTarget({ allowLocal });
if ("error" in t) {
  console.error(`\n${t.error}\n`);
  process.exit(2);
}
applyTarget(t);
// The deployed suppliers (render.yaml sets the same values on payflow-web).
process.env.DEMO_SUPPLIER_ACME_EMAIL = JUDGE_DEPLOYMENT.suppliers.acme.email;
process.env.DEMO_SUPPLIER_AWS_EMAIL = JUDGE_DEPLOYMENT.suppliers.aws.email;
// The deploy commands sign no sessions, but config validation wants a value (a fresh clone has no .env.local).
process.env.SESSION_SECRET ||= randomBytes(32).toString("base64url");
export const target: Target = t;
