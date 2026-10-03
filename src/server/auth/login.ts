import { eq, sql } from "drizzle-orm";
import { audit } from "../audit/audit";
import { db } from "../db/client";
import { users } from "../db/schema";
import { clearHits, isLimited, recordHit } from "../security/rate-limit";
import { verifyPassword } from "./password";
import { createSession } from "./session";

// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export type LoginResult = { ok: true; token: string; expiresAt: Date } | { ok: false; error: string };

export async function login(email: string, password: string, meta: { ip: string; userAgent: string | null }): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  // Only failed attempts count; a person signing in successfully is never locked out.
  const key = `login:${meta.ip}:${normalized}`;
  if (isLimited(key, 8)) return { ok: false, error: "Too many failed attempts. Try again later." };

  const [user] = await db().select().from(users).where(eq(sql`lower(${users.email})`, normalized)).limit(1);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) {
    recordHit(key, 15 * 60_000);
    return { ok: false, error: "Email or password is incorrect." };
  }
  clearHits(key);

  const session = await createSession(user.id, meta.userAgent);
  await audit({
    workspaceId: user.workspaceId,
    actor: `user:${user.id}`,
    kind: "auth.login",
    summary: `${user.email} signed in`,
  });
  return { ok: true, ...session };
}
