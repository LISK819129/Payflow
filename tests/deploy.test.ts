import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBlueprint, promptedValues } from "@/server/deploy/blueprint";
import { EXPECTED_MONTHLY_USD, JUDGE_DEPLOYMENT } from "@/server/deploy/config";
import { Report } from "@/server/deploy/report";
import { readTarget, validateTarget } from "@/server/deploy/target";
import type { PayPalRequest, PayPalResponse } from "@/server/paypal/http";
import { planWebhook } from "@/server/paypal/webhook-registration";

const BLUEPRINT = readFileSync("render.yaml", "utf8");
const problems = (text: string) => checkBlueprint(text).map((i) => `${i.path}: ${i.problem}`);

describe("Phase 11 · deployment readiness", () => {
  it("the committed render.yaml is exactly the approved deployment", () => {
    expect(problems(BLUEPRINT)).toEqual([]);
    expect(EXPECTED_MONTHLY_USD).toBeCloseTo(20.3, 2);
    expect(promptedValues(BLUEPRINT)).toEqual({
      "payflow-web": ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENAI_API_KEY", "SEED_OWNER_PASSWORD"],
      "payflow-worker": ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "OPENAI_API_KEY"],
    });
  });

  it("rejects any drift from the approved resources, plans or instance count", () => {
    expect(problems(BLUEPRINT.replace("numInstances: 1", "numInstances: 2")).join()).toMatch(/numInstances/);
    expect(problems(BLUEPRINT.replace("plan: 0.1c-256mb", "plan: 1c-1gb")).join()).toMatch(/plan/);
    expect(problems(BLUEPRINT.replace("services:", "services:\n  - type: redis\n    name: payflow-cache\n    plan: starter")).join()).toMatch(/expected exactly 2 services|redis|payflow-cache/);
  });

  it("rejects automatic deploys", () => {
    expect(problems(BLUEPRINT.replaceAll('autoDeployTrigger: "off"', 'autoDeployTrigger: "commit"')).join()).toMatch(/autoDeployTrigger/);
    // Unquoted `off` is YAML 1.1 for false in some parsers; only the string "off" is accepted.
    expect(problems(BLUEPRINT.replaceAll('autoDeployTrigger: "off"', "autoDeployTrigger: false")).join()).toMatch(/autoDeployTrigger/);
  });

  it("rejects a secret written into the file, or a secret Render would not prompt for", () => {
    const inline = (key: string, value: string) => {
      const out = BLUEPRINT.replace(new RegExp(`(- key: ${key}[^\\n]*\\n\\s+)sync: false`), `$1value: ${value}`);
      expect(out).not.toBe(BLUEPRINT);
      return out;
    };
    expect(problems(inline("OPENAI_API_KEY", "sk-proj-abcdefghijklmnopqrstuvwxyz")).join()).toMatch(/OPENAI_API_KEY/);
    expect(problems(inline("SEED_OWNER_PASSWORD", "hunter2hunter2hunter2")).join()).toMatch(/SEED_OWNER_PASSWORD/);
    expect(problems(BLUEPRINT.replace("value: sandbox", "value: live")).join()).toMatch(/PAYPAL_ENV/);
  });

  it("pins the judge login and both Sandbox suppliers", () => {
    expect(problems(BLUEPRINT.replace(JUDGE_DEPLOYMENT.suppliers.acme.email, "someone@example.com")).join()).toMatch(/DEMO_SUPPLIER_ACME_EMAIL/);
    expect(problems(BLUEPRINT.replace("value: judge@payflow.demo", "value: admin@payflow.demo")).join()).toMatch(/SEED_OWNER_EMAIL/);
    expect(JUDGE_DEPLOYMENT.suppliers.acme.email).toBe("sb-yluat53193698@personal.example.com");
    expect(JUDGE_DEPLOYMENT.suppliers.aws.email).toBe("sb-mnylb53193692@personal.example.com");
  });

  it("deploy target: https only, never the Internal Database URL, TLS added for Render", () => {
    expect(validateTarget("http://payflow.onrender.com", "postgresql://u:p@dpg-abc-a.oregon-postgres.render.com/payflow", false)).toMatchObject({ error: expect.stringMatching(/https/) });
    expect(validateTarget("https://payflow.onrender.com", "postgresql://u:p@dpg-abc123-a/payflow", false)).toMatchObject({ error: expect.stringMatching(/Internal/) });
    expect(validateTarget("http://localhost:3000", "postgresql://u:p@127.0.0.1:54329/x", false)).toMatchObject({ error: expect.stringMatching(/allow-local/) });
    const ok = validateTarget("https://payflow.onrender.com/", "postgresql://u:p@dpg-abc123-a.oregon-postgres.render.com/payflow", false);
    expect(ok).toMatchObject({ url: "https://payflow.onrender.com", local: false });
    expect("databaseUrl" in ok && new URL(ok.databaseUrl).searchParams.get("sslmode")).toBe("require");
    const local = validateTarget("http://localhost:3000", "postgresql://u:p@127.0.0.1:54329/x", true);
    expect("databaseUrl" in local && local.databaseUrl).not.toMatch(/sslmode/);
  });

  it("deploy target: a missing file becomes a fill-in template, never a guess", () => {
    const file = join(mkdtempSync(join(tmpdir(), "payflow-deploy-")), ".env.deploy.local");
    expect(readTarget({ file })).toMatchObject({ created: true });
    expect(readFileSync(file, "utf8")).toMatch(/^DEPLOY_URL=$/m);
    expect(readTarget({ file })).toMatchObject({ error: "DEPLOY_URL is empty" });
  });

  it("webhook plan is read-only and never plans a duplicate", async () => {
    const calls: PayPalRequest[] = [];
    const http = (hooks: { id: string; url: string }[]) => ({
      async request<T>(req: PayPalRequest): Promise<PayPalResponse<T>> {
        calls.push(req);
        return { status: 200, data: { webhooks: hooks } as T };
      },
    });
    const host = "https://payflow-web.onrender.com";
    let p = await planWebhook(http([{ id: "9MJ408823R309725D", url: "https://dev.trycloudflare.com/api/webhooks/paypal" }]), host);
    expect(p).toMatchObject({ action: "move", existing: { id: "9MJ408823R309725D" }, remove: [], url: `${host}/api/webhooks/paypal` });
    p = await planWebhook(http([{ id: "9MJ408823R309725D", url: `${host}/api/webhooks/paypal` }]), host);
    expect(p.action).toBe("already_here");
    p = await planWebhook(http([{ id: "A", url: "https://a.example/api/webhooks/paypal" }, { id: "B", url: "https://b.example/api/webhooks/paypal" }, { id: "X", url: "https://x.example/other" }]), host);
    expect(p).toMatchObject({ action: "move", existing: { id: "A" }, remove: [{ id: "B" }] });
    expect((await planWebhook(http([]), host)).action).toBe("create");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    await expect(planWebhook(http([]), "http://insecure.example")).rejects.toThrow(/https/);
  });

  it("the report fails only on FAIL", () => {
    const r = new Report();
    const log = console.log;
    console.log = () => {};
    try {
      r.add("a", "PASS", "ok");
      r.add("b", "WARN", "meh", "fix");
      r.add("c", "INFO", "fyi");
      expect(r.summary("t")).toBe(true);
      r.add("d", "FAIL", "broken");
      expect([r.failed, r.warned, r.summary("t")]).toEqual([1, 1, false]);
    } finally {
      console.log = log;
    }
  });
});
