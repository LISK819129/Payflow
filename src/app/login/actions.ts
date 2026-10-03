"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { login } from "@/server/auth/login";
import { SESSION_COOKIE, destroySession } from "@/server/auth/session";

export type LoginState = { error?: string; email?: string };

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password.", email };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const result = await login(email, password, { ip, userAgent: h.get("user-agent") });
  if (!result.ok) return { error: result.error, email };

  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: result.expiresAt,
  });
  redirect("/");
}

export async function logoutAction() {
  const store = await cookies();
  await destroySession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
