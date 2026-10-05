import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { aiAnalyses, simulations, workflows } from "../db/schema";
import type { AINodeOutput } from "../intelligence/node";
import type { SimStep } from "./run";

export async function getSimulation(workspaceId: string, id: string) {
  const [row] = await db()
    .select({ s: simulations, workflowName: workflows.name })
    .from(simulations)
    .innerJoin(workflows, eq(workflows.id, simulations.workflowId))
    .where(and(eq(simulations.id, id), eq(simulations.workspaceId, workspaceId)));
  if (!row) return null;
  const ids = (row.s.steps as SimStep[]).map((st) => (st.output as AINodeOutput | null)?.analysisId).filter((x): x is string => !!x);
  const analyses = ids.length
    ? await db()
        .select({ id: aiAnalyses.id, model: aiAnalyses.model, promptVersion: aiAnalyses.promptVersion, costUsd: aiAnalyses.costUsd, hits: aiAnalyses.hits, validation: aiAnalyses.validation })
        .from(aiAnalyses)
        .where(inArray(aiAnalyses.id, ids))
    : [];
  return { ...row, analyses };
}

export async function listSimulations(workspaceId: string, workflowId: string, mode: "TEST" | "OBSERVE", limit = 100) {
  return db()
    .select()
    .from(simulations)
    .where(and(eq(simulations.workspaceId, workspaceId), eq(simulations.workflowId, workflowId), eq(simulations.mode, mode)))
    .orderBy(desc(simulations.createdAt))
    .limit(limit);
}
