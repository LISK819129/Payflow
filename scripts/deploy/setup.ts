/**
 * pnpm deploy:setup  [--rotate-agent] [--allow-local]
 *
 * Run once Render has created payflow-db, payflow-web and payflow-worker (and
 * again any time — it is idempotent). From this computer, against the hosted
 * database in .env.deploy.local, it:
 *   1. checks the deployed site answers,
 *   2. brings the schema up to date (Render's pre-deploy did this already; harmless to repeat),
 *   3. checks the judge login exists (created by Render's pre-deploy from SEED_OWNER_*),
 *   4. creates or restores the demo setup — Cloud procurement, Customer refunds, their
 *      authorities with the two Sandbox suppliers, and the Cloud Procurement Agent,
 *   5. makes sure .env.agent.deploy.local holds a working demo-agent credential (never printed).
 * It never moves money, never contacts PayPal, never calls OpenAI, never deletes anything.
 */
import { allowLocal, target } from "./bootstrap";
import "../load-env";
import { and, desc, eq, sql } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { rotateCredential } from "../../src/server/agents/service";
import { closeDb, db } from "../../src/server/db/client";
import { agents, users } from "../../src/server/db/schema";
import { JUDGE_DEPLOYMENT } from "../../src/server/deploy/config";
import { DEPLOY_AGENT_FILE } from "../../src/server/deploy/target";
import { runMigrations } from "../../src/server/deploy/migrate";
import { Report, step } from "../../src/server/deploy/report";
import { DEMO_KEYS, restoreDemo } from "../../src/server/demo/setup";
import { merchantWorkspaceId } from "../../src/server/workspace";
import { writeAgentToken } from "../agent-demo/agent-token";

const rotate = process.argv.includes("--rotate-agent");

async function get(path: string) {
  const res = await fetch(`${target.url}${path}`, { signal: AbortSignal.timeout(60_000), redirect: "manual" }).catch((e: Error & { cause?: { code?: string } }) => {
    throw new Error(`cannot reach ${target.url}${path} (${e.cause?.code ?? e.name}) — is payflow-web Live in the Render Dashboard?`);
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const r = new Report();
  console.log(`PayFlow deploy:setup → ${target.url}${target.local ? " (local rehearsal)" : ""}\n`);

  await step(r, "Web service", async () => {
    const live = await get("/api/health");
    if (live.status !== 200) throw new Error(`/api/health answered ${live.status} — is payflow-web live in the Render Dashboard?`);
    r.add("Web service", "PASS", "answers /api/health");
  });

  await step(r, "Database schema", async () => {
    const m = await runMigrations();
    r.add("Database schema", "PASS", `up to date (${m.applied} migrations), job queues ready`);
  });

  let ownerId: string | null = null;
  let workspaceId: string | null = null;
  await step(r, "Judge login", async () => {
    const [u] = await db().select().from(users).where(eq(sql`lower(${users.email})`, JUDGE_DEPLOYMENT.ownerEmail));
    if (!u) {
      r.add("Judge login", "FAIL", `${JUDGE_DEPLOYMENT.ownerEmail} does not exist`, "Check SEED_OWNER_PASSWORD is set on payflow-web, then Manual Deploy → Deploy latest commit (the pre-deploy step creates it)");
      return;
    }
    if (u.role !== "OWNER") throw new Error(`${JUDGE_DEPLOYMENT.ownerEmail} exists but is ${u.role}, not OWNER`);
    ownerId = u.id;
    workspaceId = await merchantWorkspaceId();
    if (u.workspaceId !== workspaceId) throw new Error("the judge login belongs to a different workspace than the merchant workspace");
    r.add("Judge login", "PASS", `${JUDGE_DEPLOYMENT.ownerEmail} is the workspace owner`);
  });

  if (ownerId && workspaceId) {
    await step(r, "Demo setup", async () => {
      const res = await restoreDemo({ workspaceId: workspaceId!, userId: ownerId! });
      r.add("Demo setup", "PASS", res.changes.length ? res.changes.join("; ") : "already as configured — nothing changed");
      r.add("Suppliers", "INFO", `${JUDGE_DEPLOYMENT.suppliers.acme.name} → ${JUDGE_DEPLOYMENT.suppliers.acme.email}; ${JUDGE_DEPLOYMENT.suppliers.aws.name} → ${JUDGE_DEPLOYMENT.suppliers.aws.email}`);
      if (res.agentToken) {
        writeAgentToken(res.agentToken, DEPLOY_AGENT_FILE);
        r.add("Demo agent credential", "PASS", `new Cloud Procurement Agent registered; credential saved to ${DEPLOY_AGENT_FILE} (not printed)`);
        return;
      }
      const [agent] = await db()
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId!), eq(agents.demoKey, DEMO_KEYS.agent), eq(agents.status, "ACTIVE")))
        .orderBy(desc(agents.createdAt))
        .limit(1);
      const local = existsSync(DEPLOY_AGENT_FILE) ? readFileSync(DEPLOY_AGENT_FILE, "utf8") : "";
      const matches = !!agent && local.includes(`pfa_${agent.credentialId}_`);
      if (agent && (rotate || !matches)) {
        const rot = await rotateCredential({ workspaceId: workspaceId!, userId: ownerId!, agentId: agent.id });
        if (!rot.ok) throw new Error(rot.error);
        writeAgentToken(rot.token, DEPLOY_AGENT_FILE);
        r.add("Demo agent credential", "PASS", `${rotate ? "rotated on request" : "no matching local credential, so rotated"}; saved to ${DEPLOY_AGENT_FILE} (not printed). Any older copy stopped working.`);
      } else {
        r.add("Demo agent credential", "PASS", `${DEPLOY_AGENT_FILE} already holds the current credential`);
      }
    });
  }

  const ok = r.summary("deploy:setup");
  if (ok) {
    console.log(`\nNext:\n  pnpm deploy:webhook ${target.url}${allowLocal ? "   (needs the real https URL)" : ""}\n  pnpm deploy:verify${allowLocal ? " --allow-local" : ""}`);
  }
  await closeDb();
  // exitCode, not exit(): exiting while a failed socket is still closing trips a libuv assertion on Windows.
  process.exitCode = ok ? 0 : 1;
}

main().catch(async (e) => {
  console.error(`deploy:setup failed: ${(e as Error).message}`);
  await closeDb().catch(() => {});
  process.exitCode = 1;
});
