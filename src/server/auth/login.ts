import { eq, sql } from "drizzle-orm";
import { audit } from "../audit/audit";
import { db } from "../db/client";
import { users } from "../db/schema";
import { rateLimit } from "../security/rate-limit";
import { verifyPassword } from "./password";
import { createSession } from "./session";

// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export type LoginResult = { ok: true; token: string; expiresAt: Date } | { ok: false; error: string };

export async function login(email: string, password: string, meta: { ip: string; userAgent: string | null }): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  const limited = rateLimit(`login:${meta.ip}:${normalized}`, 8, 15 * 60_000);
  if (!limited.ok) return { ok: false, error: "Too many attempts. Try again later." };

  const [user] = await db().select().from(users).where(eq(sql`lower(${users.email})`, normalized)).limit(1);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) return { ok: false, error: "Email or password is incorrect." };

  const session = await createSession(user.id, meta.userAgent);
  await audit({
    workspaceId: user.workspaceId,
    actor: `user:${user.id}`,
    kind: "auth.login",
    summary: `${user.email} signed in`,
  });
  return { ok: true, ...session };
}
