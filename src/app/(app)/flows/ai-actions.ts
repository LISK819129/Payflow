"use server";

import { revalidatePath } from "next/cache";
import { compilerProvider } from "@/server/ai";
import { canAuthorize, requireUser } from "@/server/auth/current";
import { applyProposal, compileInstruction, discardProposal, proposePatch, type CompileOutcome, type PatchOutcome } from "@/server/workflow/compiler/compile";

type NotAvailable = { status: "SETUP_REQUIRED"; error: string } | { status: "FORBIDDEN"; error: string };
export type CompileActionResult = CompileOutcome | NotAvailable;
export type PatchActionResult = PatchOutcome | NotAvailable;

const SETUP = { status: "SETUP_REQUIRED" as const, error: "No AI provider is configured. Add ANTHROPIC_API_KEY to the server environment." };
const FORBIDDEN = { status: "FORBIDDEN" as const, error: "Only owners and approvers can create or edit workflows with AI." };

/** Natural language → validated DRAFT. Never activates. */
export async function compileAction(instruction: string): Promise<CompileActionResult> {
  const user = await requireUser();
  if (!canAuthorize(user)) return FORBIDDEN;
  const provider = compilerProvider({ workspaceId: user.workspaceId });
  if (!provider) return SETUP;
  const r = await compileInstruction({ workspaceId: user.workspaceId, userId: user.id, instruction, provider });
  if (r.status === "COMPILED") revalidatePath("/flows");
  return r;
}

/** Natural-language edit → proposed changes. Nothing is saved until applyProposalAction. */
export async function proposePatchAction(workflowId: string, instruction: string): Promise<PatchActionResult> {
  const user = await requireUser();
  if (!canAuthorize(user)) return FORBIDDEN;
  const provider = compilerProvider({ workspaceId: user.workspaceId });
  if (!provider) return SETUP;
  return proposePatch({ workspaceId: user.workspaceId, userId: user.id, workflowId, instruction, provider });
}

export async function applyProposalAction(compilationId: string, acknowledgeWeakening: boolean, workflowId: string) {
  const user = await requireUser();
  if (!canAuthorize(user)) return { ok: false as const, error: FORBIDDEN.error };
  const r = await applyProposal({ workspaceId: user.workspaceId, userId: user.id, compilationId, acknowledgeWeakening });
  if (r.ok) revalidatePath(`/flows/${workflowId}`);
  return r;
}

export async function discardProposalAction(compilationId: string) {
  const user = await requireUser();
  await discardProposal({ workspaceId: user.workspaceId, userId: user.id, compilationId });
  return { ok: true as const };
}
