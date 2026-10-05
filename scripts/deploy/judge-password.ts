/**
 * pnpm deploy:judge-password
 *
 * Sets a new password for the hosted judge login (judge@payflow.demo) — for when
 * the one entered in Render is forgotten. Changing SEED_OWNER_PASSWORD in Render
 * does NOT do this: the seed only creates the login when it is missing.
 *
 * The password is typed here, hidden, twice. It is never written to a file or a
 * log, and never sent anywhere except (as a scrypt hash) to the hosted database.
 * Every signed-in judge session is ended. Audited.
 */
import "./bootstrap";
import "../load-env";
import { createInterface } from "node:readline";
import { eq, sql } from "drizzle-orm";
import { appendAudit } from "../../src/server/audit/audit";
import { hashPassword } from "../../src/server/auth/password";
import { closeDb, db } from "../../src/server/db/client";
import { sessions, users } from "../../src/server/db/schema";
import { JUDGE_DEPLOYMENT } from "../../src/server/deploy/config";

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        out.output.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (the password is typed, hidden)");
  const [u] = await db().select().from(users).where(eq(sql`lower(${users.email})`, JUDGE_DEPLOYMENT.ownerEmail));
  if (!u) throw new Error(`${JUDGE_DEPLOYMENT.ownerEmail} does not exist on this database — run pnpm deploy:setup`);
  const a = await askHidden(`New password for ${JUDGE_DEPLOYMENT.ownerEmail} (16+ characters, hidden): `);
  if (a.length < 16) throw new Error("use at least 16 characters");
  const b = await askHidden("Type it again: ");
  if (a !== b) throw new Error("the two entries differ — nothing changed");
  const passwordHash = await hashPassword(a);
  await db().transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, u.id));
    await tx.delete(sessions).where(eq(sessions.userId, u.id));
    await appendAudit(tx, { workspaceId: u.workspaceId, actor: "system", kind: "user.password_reset", summary: `Password for ${u.email} reset from the deploy tools; their sessions were ended`, payload: { userId: u.id } });
  });
  console.log(`Done. ${JUDGE_DEPLOYMENT.ownerEmail} signs in with the new password; old sessions were ended.`);
}

main()
  .catch((e) => {
    console.error(`deploy:judge-password: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
