"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current";
import { demoModeEnabled, restoreDemo } from "@/server/demo/setup";
import { rateLimit } from "@/server/security/rate-limit";

/**
 * Owner-only, demo deployments only. Restores the demo configuration through
 * the audited services; never deletes, never touches PayPal or history.
 */
export async function restoreDemoAction(): Promise<{ ok: true; changes: string[]; token: string | null } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!demoModeEnabled()) return { ok: false, error: "Demo restore is only available when PAYFLOW_DEMO_MODE=true" };
  if (user.role !== "OWNER") return { ok: false, error: "Only the owner can restore the demo setup" };
  if (!rateLimit(`demo-restore:${user.workspaceId}`, 5, 60 * 60_000).ok) return { ok: false, error: "Restored too often; try again later" };
  const r = await restoreDemo({ workspaceId: user.workspaceId, userId: user.id });
  revalidatePath("/", "layout");
  return { ok: true, changes: r.changes, token: r.agentToken };
}
