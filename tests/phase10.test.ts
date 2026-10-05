import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asc, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGatewayForTests } from "@/server/actions/paypal-gateway";
import { settlementOf } from "@/server/actions/settlement";
import type { ActionGateway, ActionIntent, ActionOutcome } from "@/server/actions/types";
import { handleMcpRequest } from "@/server/agents/http";
import { getAgentRequestView } from "@/server/agents/queries";
import { syncAgentRequestForRun } from "@/server/agents/status";
import { verifyChain } from "@/server/audit/audit";
import { authoritySentence } from "@/server/authority/sentence";
import { env, productionProblems, resetEnvCache } from "@/server/config/env";
import { closeDb, db } from "@/server/db/client";
import { actionExecutions, agentRequests, agents, auditRecords, authorities, paypalEvents, simulations, workflowRuns, workflowVersions, workflows } from "@/server/db/schema";
import { environmentLabel } from "@/server/demo/queries";
import { cloudTestExamples, DEMO_KEYS, restoreDemo } from "@/server/demo/setup";
import { readiness } from "@/server/health";
import { MockAnalysisProvider } from "@/server/intelligence/mock";
import { setAnalysisProviderForTests } from "@/server/intelligence/runner";
import { registerWebhook } from "@/server/paypal/webhook-registration";
import { PayPalApiError } from "@/server/paypal/errors";
import { clientIp } from "@/server/security/client-ip";
import { checkCompileLimit, checkTestRunLimit } from "@/server/security/limits";
import { clearHits } from "@/server/security/rate-limit";
import { simulate } from "@/server/simulation/run";
import { advanceRun, decideApproval } from "@/server/workflow/runtime/engine";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { createWorkflow, saveDraft } from "@/server/workflow/service";
import { grantAuthority } from "./support/authority";
import { createUser, createWorkspace, resetTestDb } from "./support/db";

class FakePayPal implements ActionGateway {
  readonly name = "fake-paypal";
  calls: ActionIntent[] = [];
  async execute(intent: ActionIntent): Promise<ActionOutcome> {
    this.calls.push(intent);
    return { status: "succeeded", paypalRefs: [`B-${this.calls.length}`], paypalStatus: "PENDING", debugId: "d", result: {} };
  }
}

let fake: FakePayPal;
let ws: { id: string };
let owner: { id: string };
let queue: string[];
const deps: RuntimeDeps = { enqueueAdvance: async (id) => void queue.push(id), now: () => new Date() };

beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("PixelForge");
  owner = await createUser(ws.id);
  queue = [];
  fake = new FakePayPal();
  setGatewayForTests(fake);
  setAnalysisProviderForTests(new MockAnalysisProvider());
});
afterEach(() => {
  setGatewayForTests(null);
  setAnalysisProviderForTests(undefined);
  delete process.env.PAYFLOW_DEMO_MODE;
});
afterAll(closeDb);

async function drive() {
  for (let i = 0; i < 60 && queue.length; i++) {
    const id = queue.shift()!;
    await advanceRun(id, deps);
    await syncAgentRequestForRun(id);
  }
}

async function connect(token: string) {
  const client = new Client({ name: "judge-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://payflow.test/api/mcp"), {
      fetch: (url, init) => handleMcpRequest(new Request(url, init as RequestInit), deps),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  return (r.structuredContent ?? { error: { code: "PROTOCOL", message: (r.content as { text: string }[])[0]?.text } }) as Record<string, unknown> & { state?: string; reference?: string; error?: { code: string } };
}

const auditHashes = async () => (await db().select({ seq: auditRecords.seq, hash: auditRecords.hash }).from(auditRecords).where(eq(auditRecords.workspaceId, ws.id)).orderBy(asc(auditRecords.seq))).map((r) => `${r.seq}:${r.hash}`);
const n = async (t: typeof workflowRuns | typeof actionExecutions | typeof paypalEvents | typeof simulations) => (await db().select({ n: count() }).from(t))[0].n;

describe("judge / demo environment", () => {
  it("1 · demo mode never bypasses authority: the demo agent's $650 request still waits for a person; $470 gift cards are reviewed in a Test Run", async () => {
    process.env.PAYFLOW_DEMO_MODE = "true";
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const c = await connect(d.agentToken!);
    const [aws, , ] = [cloudTestExamples()[2]];
    const r = await call(c, "payflow_request_payment", {
      request_id: "judge-aws-650",
      workflow_id: d.cloudWorkflowId,
      amount: { value: "650.00", currency: "USD" },
      counterparty: (aws.values.counterparty as string),
      purpose: "EC2 GPU instances for model training",
    });
    await drive();
    const s = await call(c, "payflow_get_request", { reference: r.reference });
    expect(s.state).toBe("REVIEW_REQUIRED");
    expect(fake.calls).toHaveLength(0);
    const gift = cloudTestExamples()[1].values;
    const t = await simulate({ mode: "TEST", workspaceId: ws.id, workflowId: d.cloudWorkflowId, trigger: { kind: "manual", payload: gift as Record<string, unknown> }, userId: owner.id });
    expect(t).toMatchObject({ ok: true, verdict: "WOULD_REVIEW" });
  });

  it("2 · demo restore touches only demo records", async () => {
    const other = await createWorkflow({ workspaceId: ws.id, userId: owner.id, name: "Cloud procurement" });
    if (!other.ok) throw new Error("setup");
    const otherAuth = await grantAuthority(ws.id, owner.id, [other.workflowId], { name: "Cloud procurement", perTransactionMax: "9999" });
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    // Someone changes the demo setup…
    await saveDraft({ workspaceId: ws.id, userId: owner.id, workflowId: d.cloudWorkflowId, graph: { schemaVersion: 1, nodes: [{ id: "t", type: "trigger.manual", config: {} }, { id: "e", type: "control.terminal", config: { outcome: "completed", message: "x" } }], edges: [{ from: "t", to: "e", port: "next" }] } as never });
    const before = { wf: await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, other.workflowId)), auth: (await db().select().from(authorities).where(eq(authorities.id, otherAuth)))[0] };
    const r = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    expect(r.changes.join(" ")).toMatch(/restored “Cloud procurement” as a new version/);
    expect(await db().select().from(workflowVersions).where(eq(workflowVersions.workflowId, other.workflowId))).toEqual(before.wf);
    expect((await db().select().from(authorities).where(eq(authorities.id, otherAuth)))[0]).toEqual(before.auth);
    const [wf] = await db().select().from(workflows).where(eq(workflows.id, other.workflowId));
    expect(wf.demoKey).toBeNull();
  });

  it("3 · demo restore issues no PayPal writes and creates no runs, executions or PayPal records", async () => {
    await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    expect(fake.calls).toHaveLength(0);
    expect(await n(workflowRuns)).toBe(0);
    expect(await n(actionExecutions)).toBe(0);
    expect(await n(paypalEvents)).toBe(0);
  });

  it("4 · a Test Run on the demo flow stays isolated", async () => {
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    for (const ex of cloudTestExamples()) {
      const t = await simulate({ mode: "TEST", workspaceId: ws.id, workflowId: d.cloudWorkflowId, trigger: { kind: "manual", payload: ex.values as Record<string, unknown> }, userId: owner.id });
      expect(t.ok).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
    expect(await n(workflowRuns)).toBe(0);
    expect(await n(actionExecutions)).toBe(0);
    const verdicts = (await db().select().from(simulations).orderBy(asc(simulations.createdAt))).map((s) => s.verdict);
    expect(verdicts).toEqual(["WOULD_ALLOW", "WOULD_REVIEW", "WOULD_REVIEW"]);
  });

  it("5 · the judge agent has normal, narrow scopes — payouts through Cloud procurement only", async () => {
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const [a] = await db().select().from(agents).where(eq(agents.demoKey, DEMO_KEYS.agent));
    expect(a.scopes).toEqual([{ workflowId: d.cloudWorkflowId, actions: ["paypal.payout"], modes: ["LIVE", "TEST"] }]);
    const c = await connect(d.agentToken!);
    const r = await call(c, "payflow_request_refund", { request_id: "judge-refund-1", workflow_id: d.refundsWorkflowId, amount: { value: "5.00", currency: "USD" }, capture_id: "CAPTURE12345", purpose: "refund" });
    expect(r.error?.code).toBe("WORKFLOW_NOT_IN_SCOPE");
    // A second restore keeps the same agent; it never revives a revoked one.
    const again = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    expect(again.agentToken).toBeNull();
    await db().update(agents).set({ status: "REVOKED" }).where(eq(agents.id, a.id));
    const third = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    expect(third.agentToken).toBeTruthy();
    expect((await db().select().from(agents).where(eq(agents.id, a.id)))[0].status).toBe("REVOKED");
  });

  it("6 · the judge agent cannot approve", async () => {
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const c = await connect(d.agentToken!);
    const r = await call(c, "payflow_request_payment", { request_id: "judge-aws-650b", workflow_id: d.cloudWorkflowId, amount: { value: "650.00", currency: "USD" }, counterparty: "aws-billing@amazon.example", purpose: "GPU compute" });
    await drive();
    const [ar] = await db().select().from(agentRequests).where(eq(agentRequests.reference, r.reference!));
    const { approvals } = await import("@/server/db/schema");
    const [ap] = await db().select().from(approvals).where(eq(approvals.runId, ar.runId!));
    expect((await decideApproval({ approvalId: ap.id, workspaceId: ws.id, userId: ar.agentId, decision: "APPROVED" }, deps)).error).toMatch(/Only owners and approvers/);
    expect((await call(c, "payflow_approve", { reference: r.reference })).error).toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });

  it("7 · the environment indicator says Sandbox, and live PayPal is refused at boot", () => {
    expect(environmentLabel()).toEqual({ label: "PayPal · Sandbox", sandbox: true });
    const saved = process.env.PAYPAL_ENV;
    process.env.PAYPAL_ENV = "live";
    resetEnvCache();
    try {
      expect(() => env()).toThrow(/Sandbox only/);
    } finally {
      process.env.PAYPAL_ENV = saved;
      resetEnvCache();
    }
  });

  it("17 · demo records are distinguishable from real PayPal records", async () => {
    await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const wfs = await db().select().from(workflows);
    expect(wfs.every((w) => w.demoKey?.startsWith("demo:"))).toBe(true);
    const vs = await db().select().from(workflowVersions);
    expect(vs.every((v) => v.provenance === "USER_PROVIDED")).toBe(true);
    const auths = await db().select().from(authorities);
    expect(auths.every((a) => a.demoKey && a.description?.startsWith("Demo setup:"))).toBe(true);
    expect(await n(paypalEvents)).toBe(0); // nothing labelled REAL_PAYPAL_SANDBOX is ever seeded
  });

  it("18 · demo mechanisms never alter the audit chain — they only append", async () => {
    await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const before = await auditHashes();
    await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const after = await auditHashes();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect((await verifyChain(ws.id)).ok).toBe(true);
    const kinds = (await db().select().from(auditRecords)).map((a) => a.kind);
    expect(kinds).toContain("demo.restored");
  });
});

describe("payment status semantics", () => {
  const ex = (o: Partial<Parameters<typeof settlementOf>[0]>) => ({ kind: "paypal.payout", status: "SUCCEEDED", attempts: 1, paypalStatus: "PENDING", paypalRefs: ["B1"], error: null, confirmedByEventId: null, ...o }) as Parameters<typeof settlementOf>[0];

  it("8 · settlement mapping follows PayPal's own statuses", () => {
    expect(settlementOf(ex({}))).toMatchObject({ stage: "SUBMITTED", final: false });
    expect(settlementOf(ex({}), [{ eventType: "PAYMENT.PAYOUTSBATCH.SUCCESS", status: "SUCCESS" }])).toMatchObject({ stage: "PROCESSING", final: false, source: "paypal_webhook" });
    // The same word in PayPal's response is attributed to the response, not to a webhook.
    expect(settlementOf(ex({ paypalStatus: "SUCCESS" }))).toMatchObject({ stage: "PROCESSING", final: false, source: "paypal_response" });
    expect(settlementOf(ex({}), [{ eventType: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", status: "SUCCESS" }])).toMatchObject({ stage: "SETTLED", final: true, source: "paypal_webhook" });
    expect(settlementOf(ex({}), [{ eventType: "PAYMENT.PAYOUTS-ITEM.FAILED", status: "FAILED" }])).toMatchObject({ stage: "FAILED", final: true });
    expect(settlementOf(ex({}), [{ eventType: "PAYMENT.PAYOUTS-ITEM.RETURNED", status: "RETURNED" }])).toMatchObject({ stage: "RETURNED", final: true });
    expect(settlementOf(ex({ kind: "paypal.refund", paypalStatus: "COMPLETED" }))).toMatchObject({ stage: "SETTLED" });
    expect(settlementOf(ex({ kind: "paypal.refund", paypalStatus: "PENDING" }))).toMatchObject({ stage: "PROCESSING", final: false });
    expect(settlementOf(ex({ kind: "paypal.invoice_send", paypalStatus: "SENT" }))).toMatchObject({ stage: "DONE" });
    expect(settlementOf(ex({ status: "FAILED", attempts: 0, error: { message: "Agent revoked" } }))).toMatchObject({ stage: "NOT_SENT" });
    expect(settlementOf(ex({ status: "UNKNOWN" }))).toMatchObject({ stage: "UNKNOWN", final: false });
  });

  it("9 · a pending or unclaimed payout is never presented as settled — to agents either", async () => {
    expect(settlementOf(ex({}), [{ eventType: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", status: "UNCLAIMED" }])).toMatchObject({ stage: "AWAITING_RECIPIENT", final: false, label: "Awaiting recipient" });
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const c = await connect(d.agentToken!);
    const r = await call(c, "payflow_request_payment", { request_id: "judge-acme-185", workflow_id: d.cloudWorkflowId, amount: { value: "185.00", currency: "USD" }, counterparty: "billing@acme-cloud.example", purpose: "GPU compute" });
    await drive();
    expect((await call(c, "payflow_get_request", { reference: r.reference })).state).toBe("SUBMITTED_TO_PAYPAL");
    await db().insert(paypalEvents).values({ workspaceId: ws.id, eventId: "WH-U1", eventType: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", verification: "SELF", provenance: "REAL_PAYPAL_SANDBOX", raw: { id: "WH-U1", resource: { payout_batch_id: "B-1", transaction_status: "UNCLAIMED" } }, routedAt: new Date() });
    const s = await call(c, "payflow_get_request", { reference: r.reference });
    expect(s).toMatchObject({ state: "AWAITING_RECIPIENT", paypal: { settled: false, settlement: { stage: "AWAITING_RECIPIENT", final: false } } });
  });
});

describe("protection for a public deployment", () => {
  it("10 · AI compilation is rate limited per person", () => {
    const u = `u-${Math.random()}`;
    for (let i = 0; i < 12; i++) expect(checkCompileLimit(u, `w-${u}`).ok).toBe(true);
    const r = checkCompileLimit(u, `w-${u}`);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/limit/);
    for (let i = 0; i < 60; i++) checkTestRunLimit(`t-${u}`);
    expect(checkTestRunLimit(`t-${u}`).ok).toBe(false);
  });

  it("11 · MCP is rate limited: failed authentication per IP, and request submissions per agent", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    clearHits(`mcp-unauth:${ip}`);
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await handleMcpRequest(new Request("http://payflow.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, authorization: "Bearer nope" }, body: "{}" }), deps);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const c = await connect(d.agentToken!);
    const out = [];
    for (let i = 0; i < 21; i++) out.push(await call(c, "payflow_test_request", { request_id: `rate-test-${i}-xx`, workflow_id: d.cloudWorkflowId, action: "payout", amount: { value: "10.00", currency: "USD" }, counterparty: "billing@acme-cloud.example", purpose: "GPU compute" }));
    expect(out.at(-1)?.error?.code).toBe("RATE_LIMITED");
  });

  it("12 · the health endpoints leak no configuration", async () => {
    const r = await readiness();
    const text = JSON.stringify(r);
    expect(r.checks.database).toBe("ok");
    expect(Object.keys(r).sort()).toEqual(["checks", "environment", "status", "time"]);
    for (const k of ["DATABASE_URL", "SESSION_SECRET", "PAYPAL_CLIENT_SECRET", "PAYPAL_CLIENT_ID", "OPENAI_API_KEY", "SEED_OWNER_PASSWORD"]) {
      const v = process.env[k];
      if (v && v.length > 4) expect(text).not.toContain(v);
    }
    expect(text).not.toMatch(/postgres:|127\.0\.0\.1|password|secret/i);
    const live = await (await import("@/app/api/health/route")).GET();
    expect(await live.json()).toEqual({ status: "ok" });
  });

  it("13 · error responses carry no credentials", async () => {
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const token = d.agentToken!;
    const bad = `pfa_${token.slice(4, 16)}_${"Z".repeat(43)}`;
    for (const t of [bad, `${token}x`, token.slice(0, -1)]) {
      const res = await handleMcpRequest(new Request("http://payflow.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: "{}" }), deps);
      const body = await res.text();
      expect(body).not.toContain(token.slice(17));
      expect(body).not.toContain(t.slice(17));
    }
    const problems = productionProblems({ ...env(), NODE_ENV: "production", DATABASE_URL: "postgres://u:supersecretpassword123@db.example:5432/x", APP_URL: "http://x" } as ReturnType<typeof env>, {});
    expect(problems.join(" ")).not.toContain("supersecretpassword123");
  });

  it("14 · a hosted configuration with unsafe or missing production values is refused", () => {
    const base = { ...env(), NODE_ENV: "production" as const, APP_URL: "https://payflow.onrender.com", DATABASE_URL: "postgres://payflow:Hk2v9Zp4LqW8xT6rNm3s@dpg-123.oregon-postgres.render.com/payflow", SESSION_SECRET: "q8Zr2Lm5Nv7Xc1Pb4Wd9Ks6Hj3Gf0Ta1", PAYPAL_ALLOW_SIMULATOR_EVENTS: false };
    expect(productionProblems(base, {}, "localdevpassword")).toEqual([]);
    const issues = (o: Partial<typeof base>, raw: Record<string, string> = {}) => productionProblems({ ...base, ...o }, raw, "localdevpassword").join(" | ");
    expect(issues({ DATABASE_URL: "postgres://payflow:localdevpassword@db.render.com/payflow" })).toMatch(/reuses the local-development password/);
    expect(issues({ DATABASE_URL: "postgres://payflow:Hk2v9Zp4LqW8xT6rNm3s@127.0.0.1:54329/payflow" })).toMatch(/local database/);
    expect(issues({ DATABASE_URL: "postgres://payflow:short@db.render.com/payflow" })).toMatch(/shorter than 16/);
    expect(issues({ APP_URL: "http://payflow.onrender.com" })).toMatch(/https/);
    expect(issues({ SESSION_SECRET: "a".repeat(40) })).toMatch(/placeholder/);
    expect(issues({ PAYPAL_ALLOW_SIMULATOR_EVENTS: true })).toMatch(/SIMULATOR/);
    expect(issues({ PAYPAL_CLIENT_ID: "abc", PAYPAL_CLIENT_SECRET: undefined })).toMatch(/set together/);
    expect(issues({ OPENAI_API_KEY: "sk-test" }, { PAYFLOW_DEMO_MODE: "true" })).toMatch(/AI_DAILY_CAP_USD/);
    // A Render worker has no public URL; a Render web service gets RENDER_EXTERNAL_URL.
    expect(issues({ APP_URL: "http://localhost:3000" }, { RENDER_SERVICE_TYPE: "worker" })).toBe("");
    expect(issues({ APP_URL: "http://localhost:3000" }, { RENDER_SERVICE_TYPE: "web" })).toMatch(/https/);
    // The local production rehearsal flag only relaxes the database/URL checks.
    expect(issues({ DATABASE_URL: "postgres://payflow:localdevpassword@127.0.0.1:54329/payflow", APP_URL: "http://localhost:3000" }, { PAYFLOW_ALLOW_LOCAL_DB: "true" })).toBe("");
  });

  it("on Render, APP_URL defaults to the service's public URL", () => {
    const saved = { app: process.env.APP_URL, ext: process.env.RENDER_EXTERNAL_URL };
    delete process.env.APP_URL;
    process.env.RENDER_EXTERNAL_URL = "https://payflow-web.onrender.com";
    resetEnvCache();
    try {
      expect(env().APP_URL).toBe("https://payflow-web.onrender.com");
    } finally {
      if (saved.app === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = saved.app;
      if (saved.ext === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = saved.ext;
      resetEnvCache();
    }
  });

  it("15 · webhook registration moves the existing webhook instead of creating duplicates", async () => {
    const calls: { method: string; path: string }[] = [];
    const http = (hooks: { id: string; url: string }[], noChange = false) => ({
      async request<T>(req: { method: string; path: string }) {
        calls.push({ method: req.method, path: req.path });
        if (req.method === "GET") return { status: 200, data: { webhooks: hooks.map((h) => ({ ...h, event_types: [] })) } as T };
        if (req.method === "PATCH" && noChange) throw new PayPalApiError(400, "WEBHOOK_PATCH_REQUEST_NO_CHANGE", "no change", "dbg");
        return { status: 200, data: { id: "NEW" } as T };
      },
    });
    let r = await registerWebhook(http([{ id: "WH1", url: "https://old-tunnel.trycloudflare.com/api/webhooks/paypal" }]), "https://payflow.onrender.com");
    expect(r).toMatchObject({ action: "updated", id: "WH1", url: "https://payflow.onrender.com/api/webhooks/paypal", removed: [] });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    calls.length = 0;
    r = await registerWebhook(http([{ id: "WH1", url: "https://payflow.onrender.com/api/webhooks/paypal" }], true), "https://payflow.onrender.com");
    expect(r.action).toBe("unchanged");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    calls.length = 0;
    r = await registerWebhook(http([{ id: "WH1", url: "https://a.trycloudflare.com/api/webhooks/paypal" }, { id: "WH2", url: "https://b.trycloudflare.com/api/webhooks/paypal" }, { id: "OTHER", url: "https://elsewhere.example/hook" }]), "https://payflow.onrender.com");
    expect(r.removed).toEqual(["WH2"]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(calls.some((c) => c.path.includes("OTHER"))).toBe(false); // never touches webhooks that aren't PayFlow's
    calls.length = 0;
    r = await registerWebhook(http([]), "https://payflow.onrender.com");
    expect(r.action).toBe("created");
    await expect(registerWebhook(http([]), "http://insecure.example")).rejects.toThrow(/https/);
  });

  it("16 · the Intent Receipt page verifies the stored chain (and shows when it does not)", async () => {
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const c = await connect(d.agentToken!);
    const r = await call(c, "payflow_request_payment", { request_id: "judge-receipt-1", workflow_id: d.cloudWorkflowId, amount: { value: "650.00", currency: "USD" }, counterparty: "aws-billing@amazon.example", purpose: "GPU compute" });
    await drive();
    const v = await getAgentRequestView(ws.id, { reference: r.reference });
    expect(v?.verification).toMatchObject({ ok: true });
    expect(v?.links.length).toBeGreaterThan(0);
    const links = v!.links.map((l, i) => (i === 0 ? { ...l, data: { ...l.data, decision: "ALLOW" } } : l));
    await db().update(agentRequests).set({ links }).where(eq(agentRequests.reference, r.reference!));
    const t = await getAgentRequestView(ws.id, { reference: r.reference });
    expect(t?.verification.ok).toBe(false);
    expect(t?.verification.problems.join(" ")).toMatch(/was changed/);
  });
});

describe("correctness fixes", () => {
  it("a provider error on the first attempt is retried at once — never left waiting on its own lease", async () => {
    const d = await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const ai = new MockAnalysisProvider();
    const failedOnce = new Set<string>();
    ai.script = async (req) => {
      if (failedOnce.has(req.schemaName)) return null;
      failedOnce.add(req.schemaName);
      return { ok: false, code: "PROVIDER_ERROR", message: "temporary", model: "mock-analyst-1" } as never;
    };
    setAnalysisProviderForTests(ai);
    const started = Date.now();
    // Repeated a few times: the old lease release (now(), rounded up to the millisecond) failed intermittently.
    for (let i = 0; i < 5; i++) {
      failedOnce.clear();
      const ex = cloudTestExamples()[0].values as Record<string, unknown>;
      const t = await simulate({ mode: "TEST", workspaceId: ws.id, workflowId: d.cloudWorkflowId, trigger: { kind: "manual", payload: { ...ex, purpose: `GPU compute run ${i}` } }, userId: owner.id });
      expect(t).toMatchObject({ ok: true, verdict: "WOULD_ALLOW" });
    }
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(ai.calls.length).toBeGreaterThanOrEqual(10); // each analysis: one failure + one retry
  });
});

describe("security fixes", () => {
  it("client IP is taken from the trusted proxy's hop, not the client-controlled start of X-Forwarded-For", () => {
    const h = (v: string | null) => (name: string) => (name === "x-forwarded-for" ? v : null);
    expect(clientIp(h("6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(h("6.6.6.6, 7.7.7.7, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(h("203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(h(null), 1)).toBe("local");
  });

  it("the authority reads as one sentence, including what goes to a person", async () => {
    await restoreDemo({ workspaceId: ws.id, userId: owner.id });
    const [a] = await db().select().from(authorities).where(eq(authorities.demoKey, DEMO_KEYS.cloudAuthority));
    expect(authoritySentence(a, ["Cloud procurement"])).toBe(
      "Cloud procurement may pay Acme Cloud and AWS up to $500.00 USD per transaction, up to $5,000.00 a month, for cloud infrastructure for PixelForge's own systems: compute (including GPU), storage, networking, managed databases, and support for those services. Anything outside that purpose, over these limits or to anyone else goes to a person.",
    );
  });
});
