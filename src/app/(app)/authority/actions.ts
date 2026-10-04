"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current";
import { createAuthority, setAuthorityStatus, updateAuthority } from "@/server/authority/service";

export type AuthorityActionResult = { ok: true; id: string; version: number } | { ok: false; error: string };

/** Delegated financial authority is changed only by an owner, and every change is audited. */
async function owner() {
  const user = await requireUser();
  if (user.role !== "OWNER") return { user, error: "Only an owner can change financial authority" };
  return { user, error: null };
}

export async function createAuthorityAction(data: unknown): Promise<AuthorityActionResult> {
  const { user, error } = await owner();
  if (error) return { ok: false, error };
  const r = await createAuthority({ workspaceId: user.workspaceId, userId: user.id, data });
  if (r.ok) revalidatePath("/authority");
  return r;
}

export async function updateAuthorityAction(id: string, data: unknown): Promise<AuthorityActionResult> {
  const { user, error } = await owner();
  if (error) return { ok: false, error };
  const r = await updateAuthority({ workspaceId: user.workspaceId, userId: user.id, authorityId: id, data });
  if (r.ok) revalidatePath("/authority");
  return r;
}

export async function setAuthorityStatusAction(id: string, to: "ACTIVE" | "SUSPENDED" | "REVOKED", reason?: string): Promise<AuthorityActionResult> {
  const { user, error } = await owner();
  if (error) return { ok: false, error };
  const r = await setAuthorityStatus({ workspaceId: user.workspaceId, userId: user.id, authorityId: id, to, reason });
  if (r.ok) revalidatePath("/authority");
  return r;
}
