import { parse } from "yaml";
import { JUDGE_DEPLOYMENT } from "./config";

/**
 * Checks render.yaml before anything is created on Render: exactly the three
 * approved resources on the approved plans, one web instance, deploys only on
 * request, and no secret values written into the file.
 */
type EnvVar = { key?: string; value?: unknown; sync?: boolean; generateValue?: boolean; fromDatabase?: unknown; fromGroup?: string };
type Service = { type?: string; name?: string; plan?: string; numInstances?: number; autoDeployTrigger?: unknown; autoDeploy?: unknown; envVars?: EnvVar[]; preDeployCommand?: string };
type Blueprint = { databases?: { name?: string; plan?: string }[]; services?: Service[]; envVarGroups?: unknown[] };

const SECRET_KEY = /(SECRET|PASSWORD|API_KEY|TOKEN|CLIENT_ID|DATABASE_URL)/;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{16,}|pfa_[0-9a-f]{12}_|postgres(ql)?:\/\/|-----BEGIN)/;

export type BlueprintIssue = { path: string; problem: string };

export function checkBlueprint(text: string): BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  let bp: Blueprint;
  try {
    bp = parse(text) as Blueprint;
  } catch (e) {
    return [{ path: "render.yaml", problem: `not valid YAML: ${(e as Error).message}` }];
  }
  const want = JUDGE_DEPLOYMENT.resources;
  const dbs = bp.databases ?? [];
  const svcs = bp.services ?? [];
  if (bp.envVarGroups?.length) issues.push({ path: "envVarGroups", problem: "no environment groups (sync: false is not allowed in them)" });
  if (dbs.length !== 1) issues.push({ path: "databases", problem: `expected exactly 1 database, found ${dbs.length}` });
  if (svcs.length !== 2) issues.push({ path: "services", problem: `expected exactly 2 services (web, worker), found ${svcs.length}` });

  const db = dbs.find((d) => d.name === "payflow-db");
  if (!db) issues.push({ path: "databases", problem: "payflow-db missing" });
  else if (db.plan !== want[0].plan) issues.push({ path: "databases[payflow-db].plan", problem: `expected ${want[0].plan}, found ${db.plan}` });

  for (const r of want.slice(1)) {
    const s = svcs.find((x) => x.name === r.name);
    const at = `services[${r.name}]`;
    if (!s) {
      issues.push({ path: "services", problem: `${r.name} missing` });
      continue;
    }
    if (s.type !== r.kind) issues.push({ path: `${at}.type`, problem: `expected ${r.kind}, found ${s.type}` });
    if (s.plan !== r.plan) issues.push({ path: `${at}.plan`, problem: `expected ${r.plan}, found ${s.plan}` });
    if (s.numInstances !== 1) issues.push({ path: `${at}.numInstances`, problem: "must be exactly 1 (rate limits are per process)" });
    if (s.autoDeployTrigger !== "off") issues.push({ path: `${at}.autoDeployTrigger`, problem: `must be the string "off" (found ${JSON.stringify(s.autoDeployTrigger)})` });
    if (s.autoDeploy !== undefined) issues.push({ path: `${at}.autoDeploy`, problem: "deprecated field; use autoDeployTrigger" });
    const env = s.envVars ?? [];
    const get = (k: string) => env.find((e) => e.key === k);
    for (const e of env) {
      if (e.fromGroup) issues.push({ path: `${at}.envVars`, problem: "fromGroup is not used in this deployment" });
      if (!e.key) continue;
      if (SECRET_KEY.test(e.key) && !(e.sync === false || e.generateValue || e.fromDatabase)) issues.push({ path: `${at}.envVars.${e.key}`, problem: "a secret must be sync: false, generateValue or fromDatabase — never a value in the file" });
      if (typeof e.value === "string" && SECRET_VALUE.test(e.value)) issues.push({ path: `${at}.envVars.${e.key}`, problem: "looks like a secret value written into the file" });
    }
    if (get("NODE_ENV") && r.kind === "web") issues.push({ path: `${at}.envVars.NODE_ENV`, problem: "do not set NODE_ENV on the web service (pnpm would skip build dependencies)" });
    if (get("PAYPAL_ENV")?.value !== "sandbox") issues.push({ path: `${at}.envVars.PAYPAL_ENV`, problem: "must be sandbox" });
    if (get("PAYPAL_WEBHOOK_ID")?.value !== JUDGE_DEPLOYMENT.webhookId) issues.push({ path: `${at}.envVars.PAYPAL_WEBHOOK_ID`, problem: `must be the existing webhook ${JUDGE_DEPLOYMENT.webhookId}` });
    if (!get("AI_DAILY_CAP_USD")) issues.push({ path: `${at}.envVars.AI_DAILY_CAP_USD`, problem: "the public demo needs a daily AI cap" });
    for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENAI_API_KEY"]) if (get(k)?.sync !== false) issues.push({ path: `${at}.envVars.${k}`, problem: "must be sync: false (entered in the Render Dashboard)" });
    if (r.kind === "web") {
      if (get("SEED_OWNER_EMAIL")?.value !== JUDGE_DEPLOYMENT.ownerEmail) issues.push({ path: `${at}.envVars.SEED_OWNER_EMAIL`, problem: `must be ${JUDGE_DEPLOYMENT.ownerEmail}` });
      if (get("SEED_OWNER_PASSWORD")?.sync !== false) issues.push({ path: `${at}.envVars.SEED_OWNER_PASSWORD`, problem: "must be sync: false" });
      if (get("DEMO_SUPPLIER_ACME_EMAIL")?.value !== JUDGE_DEPLOYMENT.suppliers.acme.email) issues.push({ path: `${at}.envVars.DEMO_SUPPLIER_ACME_EMAIL`, problem: "must be the Acme Cloud Sandbox account" });
      if (get("DEMO_SUPPLIER_AWS_EMAIL")?.value !== JUDGE_DEPLOYMENT.suppliers.aws.email) issues.push({ path: `${at}.envVars.DEMO_SUPPLIER_AWS_EMAIL`, problem: "must be the AWS Demo Sandbox account" });
      if (!/db:migrate/.test(s.preDeployCommand ?? "")) issues.push({ path: `${at}.preDeployCommand`, problem: "must run pnpm db:migrate" });
    }
  }
  return issues;
}

/** Which sync: false values Render will ask for, per service (for the instructions). */
export function promptedValues(text: string): Record<string, string[]> {
  const bp = parse(text) as Blueprint;
  return Object.fromEntries((bp.services ?? []).map((s) => [s.name ?? "?", (s.envVars ?? []).filter((e) => e.sync === false).map((e) => e.key ?? "?")]));
}
