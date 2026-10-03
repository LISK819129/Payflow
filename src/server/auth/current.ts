import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, resolveSession, type SessionUser } from "./session";

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/** For pages and server actions: the signed-in user, or a redirect to /login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Roles allowed to approve money movement or activate workflows. */
export function canAuthorize(user: SessionUser) {
  return user.role === "OWNER" || user.role === "APPROVER";
}
