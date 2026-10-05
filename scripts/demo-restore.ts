/**
 * Creates or restores the judge/demo setup (two workflows, their authorities,
 * the Cloud Procurement Agent) through PayFlow's audited services. Idempotent.
 * Touches only records with a demo_key; never deletes, never contacts PayPal.
 *
 *   pnpm demo:restore
 *
 * If a new demo agent credential is issued it is written to .env.agent.local
 * (git-ignored) and never printed.
 */
import "./load-env";
import { and, eq } from "drizzle-orm";
import { writeAgentToken } from "./agent-demo/agent-token";
import { closeDb, db } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { restoreDemo } from "../src/server/demo/setup";
import { merchantWorkspaceId } from "../src/server/workspace";

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const [owner] = await db().select().from(users).where(and(eq(users.workspaceId, workspaceId), eq(users.role, "OWNER"))).limit(1);
  if (!owner) throw new Error("No owner: run pnpm db:seed first");
  const r = await restoreDemo({ workspaceId, userId: owner.id });
  if (r.agentToken) writeAgentToken(r.agentToken);
  console.log(r.changes.length ? `[demo] ${r.changes.join("\n[demo] ")}` : "[demo] already as configured");
  if (r.agentToken) console.log("[demo] new agent credential written to .env.agent.local (not printed)");
  console.log(`[demo] Cloud procurement ${r.cloudWorkflowId} · Customer refunds ${r.refundsWorkflowId}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
