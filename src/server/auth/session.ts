import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { sha256Hex } from "../audit/canonical";
import { db } from "../db/client";
import { sessions, users, workspaces } from "../db/schema";

export const SESSION_COOKIE = "pf_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 h

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "APPROVER" | "VIEWER";
  workspaceId: string;
  workspaceName: string;
};

/** Returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(userId: string, userAgent?: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db()
    .insert(sessions)
    .values({ idHash: sha256Hex(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300) ?? null });
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      workspaceId: users.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(and(eq(sessions.idHash, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function destroySession(token: string | undefined | null) {
  if (!token) return;
  await db().delete(sessions).where(eq(sessions.idHash, sha256Hex(token)));
}

export async function purgeExpiredSessions() {
  await db().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
