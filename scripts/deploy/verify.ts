/**
 * pnpm deploy:verify  [--scenarios] [--webhook-test] [--allow-local]
 *
 * Checks the deployed PayFlow without moving money and, by default, without
 * spending OpenAI credit. PASS / WARN / FAIL per check; exit code 1 on any FAIL.
 *
 *   --scenarios     also run the four judge Test Runs through MCP (TEST mode: PayPal is never
 *                   contacted). The first run makes a few small OpenAI calls (well under $0.05);
 *                   later runs replay the same request ids and cost nothing.
 *   --webhook-test  also prove real webhook delivery: creates ONE harmless Sandbox catalog product
 *                   (no money) and waits for PayPal's CATALOG.PRODUCT.CREATED to reach the site.
 */
import { allowLocal, target } from "./bootstrap";
import "../load-env";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { verifyChain } from "../../src/server/audit/audit";
import { closeDb, db } from "../../src/server/db/client";
import { agents, aiUsage, auditRecords, authorities, paypalEvents, users, workerHeartbeats, workflows } from "../../src/server/db/schema";
import { JUDGE_DEPLOYMENT } from "../../src/server/deploy/config";
import { Report, step } from "../../src/server/deploy/report";
import { DEPLOY_AGENT_FILE } from "../../src/server/deploy/target";
import { cloudTestExamples, DEMO_KEYS } from "../../src/server/demo/setup";
import { paypal } from "../../src/server/paypal/client";
import { planWebhook } from "../../src/server/paypal/webhook-registration";
import { merchantWorkspaceId } from "../../src/server/workspace";

const scenarios = process.argv.includes("--scenarios");
const webhookTest = process.argv.includes("--webhook-test");
const URL_ = target.url;

async function http(path: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_}${path}`, { ...init, signal: AbortSignal.timeout(60_000), redirect: "manual" }).catch((e: Error & { cause?: { code?: string } }) => {
    throw new Error(`cannot reach ${URL_}${path} (${e.cause?.code ?? e.name}) — is payflow-web Live in the Render Dashboard? (a first deploy takes ~5 minutes)`);
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function agentToken(): string | null {
  if (!existsSync(DEPLOY_AGENT_FILE)) return null;
  return /^AGENT_TOKEN=(pfa_[0-9a-f]{12}_[A-Za-z0-9_-]{43})$/m.exec(readFileSync(DEPLOY_AGENT_FILE, "utf8"))?.[1] ?? null;
}

async function main() {
  const r = new Report();
  console.log(`PayFlow deploy:verify → ${URL_}${target.local ? " (local rehearsal)" : ""}\n`);

  // ── The site ────────────────────────────────────────────────────────────
  await step(r, "Web liveness", async () => {
    const h = await http("/api/health");
    r.add("Web liveness", h.status === 200 ? "PASS" : "FAIL", `/api/health → ${h.status}`, h.status === 200 ? undefined : "Render Dashboard → payflow-web → Logs");
  });
  let ready: { status?: string; checks?: Record<string, string> } = {};
  await step(r, "Readiness", async () => {
    const h = await http("/api/health/ready");
    ready = JSON.parse(h.text);
    r.add("Readiness", ready.status === "ready" ? "PASS" : "FAIL", `/api/health/ready → ${h.status} ${ready.status}`);
    const c = ready.checks ?? {};
    const want: [string, string, string, string][] = [
      ["database", "ok", "FAIL", "payflow-db must be Available"],
      ["migrations", "current", "FAIL", "Manual Deploy payflow-web (its pre-deploy migrates) or run pnpm deploy:setup"],
      ["paypal", "configured", "FAIL", "enter PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET on payflow-web and payflow-worker"],
      ["paypalWebhook", "configured", "FAIL", "PAYPAL_WEBHOOK_ID comes from render.yaml — check payflow-web's Environment"],
      ["ai", "configured", "WARN", "enter OPENAI_API_KEY on payflow-web and payflow-worker (AI drafting/analysis is unavailable without it)"],
      ["worker", "recent", "FAIL", "payflow-worker must be running — Render Dashboard → payflow-worker → Logs"],
    ];
    for (const [k, v, bad, fix] of want) r.add(`  ${k}`, c[k] === v ? "PASS" : (bad as "FAIL" | "WARN"), c[k] ?? "missing", c[k] === v ? undefined : fix);
  });
  await step(r, "Security headers", async () => {
    const h = await http("/login");
    const ok = h.headers.get("x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(h.headers.get("content-security-policy") ?? "") && h.headers.get("x-content-type-options") === "nosniff" && !h.headers.get("x-powered-by");
    r.add("Security headers", ok && h.status === 200 ? "PASS" : "WARN", `login page ${h.status}; frame-ancestors none, nosniff, no X-Powered-By${ok ? "" : " — not all present"}`);
  });

  // ── MCP ─────────────────────────────────────────────────────────────────
  await step(r, "MCP refuses strangers", async () => {
    const h = await http("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    r.add("MCP refuses strangers", h.status === 401 && !!h.headers.get("www-authenticate") ? "PASS" : "FAIL", `unauthenticated POST /api/mcp → ${h.status}`);
  });
  const token = agentToken();
  let cloudId: string | null = null;
  if (!token) r.add("MCP as the demo agent", "WARN", `no ${DEPLOY_AGENT_FILE}`, "run pnpm deploy:setup (it saves the demo agent's credential)");
  else {
    await step(r, "MCP as the demo agent", async () => {
      const client = new Client({ name: "payflow-deploy-verify", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      try {
        const tools = (await client.listTools()).tools.map((t) => t.name);
        const caps = (await client.callTool({ name: "payflow_list_capabilities", arguments: {} })).structuredContent as { agent?: { name: string; status: string }; can_request?: { workflow_id: string; workflow_name: string; actions: string[]; modes: string[] }[] };
        const scope = caps.can_request?.[0];
        cloudId = scope?.workflow_id ?? null;
        r.add("MCP as the demo agent", tools.length === 7 && caps.agent?.status === "ACTIVE" ? "PASS" : "FAIL", `${tools.length} tools; ${caps.agent?.name} ${caps.agent?.status}; may request ${scope?.actions.join("/")} via ${scope?.workflow_name} (${scope?.modes.join("+")})`);
        if (scenarios && cloudId) {
          const expected = ["WOULD_ALLOW", "WOULD_REVIEW", "WOULD_REVIEW", "WOULD_DENY"];
          for (const [i, ex] of cloudTestExamples().entries()) {
            const v = ex.values as { amount: { value: string; currency_code: string }; counterparty: string; purpose: string; invoice: string };
            const args = { workflow_id: cloudId, action: "payout", amount: { value: v.amount.value, currency: v.amount.currency_code }, counterparty: v.counterparty, purpose: v.purpose, evidence: { invoice_text: v.invoice } };
            // Same request → same id → PayFlow replays the stored answer (no new AI spend on re-runs).
            const request_id = `deploy-verify-${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16)}`;
            const out = (await client.callTool({ name: "payflow_test_request", arguments: { request_id, ...args } })).structuredContent as { state?: string; replayed?: boolean; test?: { verdict: string; headline: string }; error?: { code: string; message: string } };
            const verdict = out.test?.verdict ?? out.error?.code ?? "?";
            r.add(`  Test Run: ${ex.label}`, verdict === expected[i] ? "PASS" : "FAIL", `${verdict}${out.replayed ? " (replayed, no new AI)" : ""} — expected ${expected[i]}; PayPal not contacted`);
          }
        }
      } finally {
        await client.close();
      }
    });
  }

  // ── The hosted database ─────────────────────────────────────────────────
  let workspaceId = "";
  await step(r, "Judge login", async () => {
    const [u] = await db().select().from(users).where(eq(sql`lower(${users.email})`, JUDGE_DEPLOYMENT.ownerEmail));
    r.add("Judge login", u?.role === "OWNER" ? "PASS" : "FAIL", u ? `${u.email} (${u.role})` : `${JUDGE_DEPLOYMENT.ownerEmail} missing`, u ? undefined : "set SEED_OWNER_PASSWORD on payflow-web and redeploy");
    workspaceId = await merchantWorkspaceId();
  });
  await step(r, "Demo setup", async () => {
    const wfs = await db().select().from(workflows).where(and(eq(workflows.workspaceId, workspaceId), sql`${workflows.demoKey} is not null`));
    const auths = await db().select().from(authorities).where(and(eq(authorities.workspaceId, workspaceId), sql`${authorities.demoKey} is not null`));
    const [agent] = await db().select().from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.demoKey, DEMO_KEYS.agent), eq(agents.status, "ACTIVE"))).orderBy(desc(agents.createdAt)).limit(1);
    const cloudAuth = auths.find((a) => a.demoKey === DEMO_KEYS.cloudAuthority);
    const allow = cloudAuth?.counterparties.map((c) => c.id) ?? [];
    const suppliersOk = allow.includes(JUDGE_DEPLOYMENT.suppliers.acme.email) && allow.includes(JUDGE_DEPLOYMENT.suppliers.aws.email);
    const flowsOk = wfs.length >= 2 && wfs.every((w) => w.state === "ACTIVE");
    const authOk = auths.length >= 2 && auths.every((a) => a.status === "ACTIVE");
    const agentOk = !!agent && (!agent.expiresAt || agent.expiresAt > new Date());
    r.add("Demo setup", flowsOk && authOk && agentOk && suppliersOk ? "PASS" : "FAIL", `${wfs.length} demo flows (${wfs.map((w) => `${w.name} ${w.state}`).join(", ")}); ${auths.length} authorities; agent ${agent ? `${agent.name} until ${agent.expiresAt?.toISOString().slice(0, 10) ?? "revoked"}` : "missing"}; suppliers ${suppliersOk ? "mapped" : "NOT mapped"}`, flowsOk && authOk && agentOk && suppliersOk ? undefined : "run pnpm deploy:setup");
  });
  await step(r, "Worker version", async () => {
    const [hb] = await db().select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt)).limit(1);
    if (!hb) return void r.add("Worker version", "FAIL", "no worker has ever started", "Render Dashboard → payflow-worker → Logs");
    let head = "";
    try {
      head = execFileSync("git", ["rev-parse", "--short", "origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      /* not a git checkout */
    }
    const fresh = Date.now() - hb.lastSeenAt.getTime() < 5 * 60_000;
    const same = !head || !hb.commit || head.startsWith(hb.commit) || hb.commit.startsWith(head);
    r.add("Worker version", fresh && same ? "PASS" : "WARN", `last seen ${Math.round((Date.now() - hb.lastSeenAt.getTime()) / 1000)} s ago, running ${hb.commit ?? "unknown commit"}${head ? ` (origin/main is ${head})` : ""}`, same ? undefined : "Manual Deploy → Deploy latest commit on payflow-worker");
  });
  await step(r, "AI spend (hosted)", async () => {
    const [day] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` }).from(aiUsage).where(gte(aiUsage.at, new Date(Date.now() - 86_400_000)));
    const [all] = await db().select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${aiUsage.costUsd}::numeric),0)::text` }).from(aiUsage);
    r.add("AI spend (hosted)", "INFO", `last 24 h: ${day.calls} calls $${Number(day.cost).toFixed(4)} (cap $1/day in render.yaml); total ${all.calls} calls $${Number(all.cost).toFixed(4)} (cap $5)`);
  });
  await step(r, "Audit chain", async () => {
    const v = await verifyChain(workspaceId);
    r.add("Audit chain", v.ok ? "PASS" : "FAIL", v.ok ? `${v.records} records, intact` : `broken: ${JSON.stringify(v).slice(0, 200)}`);
    const [bad] = await db().select({ n: sql<number>`count(*)::int` }).from(auditRecords).where(and(eq(auditRecords.workspaceId, workspaceId), eq(auditRecords.kind, "paypal.event.confirm_failed"), gte(auditRecords.at, new Date(Date.now() - 86_400_000))));
    if (bad.n > 0) r.add("PayPal event confirmations", "WARN", `${bad.n} event(s) could not be confirmed with PayPal in the last 24 h`, "check PAYPAL_CLIENT_ID / SECRET on payflow-worker");
  });

  // ── PayPal and OpenAI (with this computer's .env.local — the same Sandbox app and key) ──
  await step(r, "PayPal webhook", async () => {
    if (target.local) return void r.add("PayPal webhook", "INFO", "skipped for a local rehearsal (PayPal needs a public https URL)");
    const plan = await planWebhook(paypal(), URL_);
    r.add(
      "PayPal webhook",
      plan.action === "already_here" ? "PASS" : "WARN",
      plan.action === "already_here" ? `${plan.existing?.id} delivers to ${plan.url}` : `points at ${plan.existing?.url ?? "nothing"}`,
      plan.action === "already_here" ? undefined : `pnpm deploy:webhook ${URL_}`,
    );
    if (plan.existing && plan.existing.id !== JUDGE_DEPLOYMENT.webhookId) r.add("PayPal webhook id", "WARN", `${plan.existing.id} ≠ render.yaml ${JUDGE_DEPLOYMENT.webhookId}`, `set PAYPAL_WEBHOOK_ID=${plan.existing.id} on both services and redeploy`);
  });
  await step(r, "OpenAI key", async () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return void r.add("OpenAI key", "WARN", "no OPENAI_API_KEY in this computer's .env.local to test", "the hosted key is checked by readiness (configured) only");
    const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    r.add("OpenAI key", res.ok ? "PASS" : "FAIL", res.ok ? "valid (checked with the free model list — no tokens spent)" : `OpenAI answered ${res.status}`, res.ok ? "make sure Render has the same key" : "replace OPENAI_API_KEY");
  });

  if (webhookTest) {
    await step(r, "Real webhook delivery", async () => {
      if (target.local) return void r.add("Real webhook delivery", "INFO", "skipped for a local rehearsal");
      const product = await paypal().request<{ id: string }>({
        method: "POST",
        path: "/v1/catalogs/products",
        requestId: `deploy-verify-${randomUUID()}`,
        body: { name: "PayFlow deploy check", description: "Harmless product created by pnpm deploy:verify --webhook-test (no money)", type: "SERVICE", category: "SOFTWARE" },
      });
      for (let i = 0; i < 45; i++) {
        const [ev] = await db().select().from(paypalEvents).where(and(eq(paypalEvents.eventType, "CATALOG.PRODUCT.CREATED"), eq(paypalEvents.resourceId, product.data.id)));
        if (ev?.routedAt) return void r.add("Real webhook delivery", "PASS", `PayPal delivered CATALOG.PRODUCT.CREATED for ${product.data.id}; verified (${ev.verification}) and processed by the worker`);
        await new Promise((res) => setTimeout(res, 4000));
      }
      r.add("Real webhook delivery", "FAIL", `no CATALOG.PRODUCT.CREATED for ${product.data.id} after 3 minutes`, `pnpm deploy:webhook ${URL_}, then check payflow-web logs for "[webhook] rejected"`);
    });
  }

  const ok = r.summary("deploy:verify");
  if (ok && !scenarios) console.log(`\nOptional: pnpm deploy:verify --scenarios${allowLocal ? " --allow-local" : ""}   (the four judge Test Runs through MCP; no money, < $0.05 of AI once)`);
  await closeDb();
  // exitCode, not exit(): exiting while a failed socket is still closing trips a libuv assertion on Windows.
  process.exitCode = ok ? 0 : 1;
}

main().catch(async (e) => {
  console.error(`deploy:verify failed: ${(e as Error).message}`);
  await closeDb().catch(() => {});
  process.exitCode = 1;
});
