"use server";

import { revalidatePath } from "next/cache";
import { registerAgent, revokeAgent, rotateCredential } from "@/server/agents/service";
import { requireUser } from "@/server/auth/current";
import type { AgentScope } from "@/server/db/schema";
import { runtimeDeps } from "@/server/workflow/runtime/deps";

type Result = { ok: true; id?: string; token?: string } | { ok: false; error: string };

/**
 * Owner-only. The raw credential is returned exactly once, to the owner's
 * browser, and is never stored or shown again.
 */
export async function registerAgentAction(input: { name: string; description: string; scopes: AgentScope[]; expiresInDays: number | null }): Promise<Result> {
  const user = await requireUser();
  if (user.role !== "OWNER") return { ok: false, error: "Only the owner can register agents" };
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const r = await registerAgent({ workspaceId: user.workspaceId, userId: user.id, name: input.name, description: input.description, scopes: input.scopes, expiresAt });
  if (!r.ok) return r;
  revalidatePath("/agents");
  return { ok: true, id: r.agent.id, token: r.token };
}

export async function rotateAgentAction(agentId: string): Promise<Result> {
  const user = await requireUser();
  if (user.role !== "OWNER") return { ok: false, error: "Only the owner can rotate credentials" };
  const r = await rotateCredential({ workspaceId: user.workspaceId, userId: user.id, agentId });
  if (!r.ok) return r;
  revalidatePath(`/agents/${agentId}`);
  return { ok: true, token: r.token };
}

export async function revokeAgentAction(agentId: string, reason: string): Promise<Result> {
  const user = await requireUser();
  if (user.role !== "OWNER") return { ok: false, error: "Only the owner can revoke agents" };
  const r = await revokeAgent({ workspaceId: user.workspaceId, userId: user.id, agentId, reason: reason || undefined }, runtimeDeps);
  if (!r.ok) return r;
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
  return { ok: true };
}
