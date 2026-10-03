import { asc } from "drizzle-orm";
import { db } from "./db/client";
import { workspaces } from "./db/schema";

let cached: string | undefined;

/**
 * The workspace that owns this deployment's PayPal app. One PayPal app is bound
 * to one workspace (multi-merchant onboarding is future work). Set
 * PAYFLOW_WORKSPACE_ID to pin it; otherwise the single existing workspace is used.
 */
export async function merchantWorkspaceId(): Promise<string> {
  if (cached) return cached;
  if (process.env.PAYFLOW_WORKSPACE_ID) return (cached = process.env.PAYFLOW_WORKSPACE_ID);
  const rows = await db().select({ id: workspaces.id }).from(workspaces).orderBy(asc(workspaces.createdAt)).limit(2);
  if (rows.length !== 1) {
    throw new Error(`Cannot pick the merchant workspace: ${rows.length} workspaces exist; set PAYFLOW_WORKSPACE_ID`);
  }
  return (cached = rows[0].id);
}

export function resetWorkspaceCache() {
  cached = undefined;
}
