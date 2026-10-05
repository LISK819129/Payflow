/**
 * pnpm deploy:check
 *
 * Validates render.yaml before anything exists on Render. Creates nothing.
 *   1. PayFlow's own rules: exactly payflow-db (Basic-256mb), payflow-web (Starter, 1 instance)
 *      and payflow-worker (Starter); deploys only on request; no secret values in the file.
 *   2. If the Render CLI is installed and logged in, Render's own validator. Until a payment
 *      method is on the workspace it answers "need_payment_info" for each paid resource —
 *      reported as WARN, because that is expected, not a mistake in the file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkBlueprint, promptedValues } from "../../src/server/deploy/blueprint";
import { EXPECTED_MONTHLY_USD, JUDGE_DEPLOYMENT } from "../../src/server/deploy/config";
import { Report } from "../../src/server/deploy/report";

function renderCli(): string | null {
  for (const c of [process.env.RENDER_CLI, "D:\\.cache\\bin\\render.exe", "render"]) {
    if (!c) continue;
    try {
      execFileSync(c, ["--version"], { stdio: "ignore", timeout: 20_000 });
      return c;
    } catch {
      /* try the next */
    }
  }
  return null;
}

const r = new Report();
const text = readFileSync("render.yaml", "utf8");
const issues = checkBlueprint(text);
if (issues.length) for (const i of issues) r.add(`render.yaml ${i.path}`, "FAIL", i.problem);
else r.add("render.yaml", "PASS", "exactly the 3 approved resources, 1 web instance, auto-deploy off, no secrets in the file");

for (const res of JUDGE_DEPLOYMENT.resources) r.add(`  ${res.name}`, "INFO", `${res.kind}, plan ${res.plan}, ~$${res.monthlyUsd.toFixed(2)}/month`);
r.add("Expected cost", "INFO", `~$${EXPECTED_MONTHLY_USD.toFixed(2)}/month (charged per second while the resources exist)`);
for (const [svc, keys] of Object.entries(promptedValues(text))) r.add(`Render will ask for (${svc})`, "INFO", keys.join(", "));

const cli = renderCli();
if (!cli) {
  r.add("Render validator", "WARN", "Render CLI not found — skipped", "optional: install it, run `render login`, then pnpm deploy:check again");
} else {
  let out = "";
  try {
    out = execFileSync(cli, ["blueprints", "validate", "render.yaml", "-o", "json", "--confirm"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message;
  }
  let parsed: { valid?: boolean; errors?: { error?: string; path?: string; message?: string }[] } | null = null;
  try {
    parsed = JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    parsed = null;
  }
  if (parsed?.valid) r.add("Render validator", "PASS", "Render accepts render.yaml");
  else if (parsed?.errors?.length && parsed.errors.every((e) => e.error === "need_payment_info"))
    r.add("Render validator", "WARN", `file accepted; Render needs a payment method before it can create ${parsed.errors.length} paid resources`, "Render Dashboard → Workspace Settings → Billing → add a payment method (only when you are ready to deploy)");
  else if (/not logged in|unauthori[sz]ed|login/i.test(out)) r.add("Render validator", "WARN", "Render CLI is not logged in — skipped", "run `render login` (opens your browser), then pnpm deploy:check again");
  else r.add("Render validator", "FAIL", (parsed?.errors ?? []).map((e) => `${e.path ?? ""} ${e.error ?? ""} ${e.message ?? ""}`.trim()).join("; ") || out.trim().slice(0, 400));
}

const ok = r.summary("deploy:check");
process.exit(ok ? 0 : 1);
