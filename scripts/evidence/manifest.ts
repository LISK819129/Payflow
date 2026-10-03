/**
 * Builds evidence/phase4/manifest.json from the database records (not typed by
 * hand): every real AI call with its tokens and cost, every compilation with
 * its outcome, and the end-to-end PayPal run with its IDs. Contains no secrets.
 *
 *   pnpm evidence:manifest
 */
import "../load-env";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "../../src/server/db/client";
import { aiCompilations, aiUsage, approvals, auditRecords, paypalEvents, runSteps, workflowRuns, workflowVersions } from "../../src/server/db/schema";
import { verifyChain } from "../../src/server/audit/audit";
import { merchantWorkspaceId } from "../../src/server/workspace";
import { SCENARIOS } from "./scenarios";

const OUT = path.resolve("evidence/phase4");

/** Which scenario each real compilation belongs to (in the order they were run). */
const SCENARIO_OF: Record<string, { scenario: string; note?: string }> = {
  "e0312663-4ba0-4158-836f-64e6748948be": { scenario: "A-simple" },
  "2a4a4df3-a0ba-4712-b238-b3aeac310bc6": { scenario: "B-nova", note: "round 1: clarification requested" },
  "712e9b96-e9ff-49ee-949c-e6c3a6f821de": { scenario: "B-nova", note: "round 2: capture-tool bug shifted the answers by one field; the model correctly re-asked" },
  "3e0cfe66-0295-4264-857d-a96aacc6e3bb": { scenario: "B-nova", note: "round 3: new design questions (reminder data source, cap semantics, agent trigger)" },
  "ea0c35bf-5b2f-46c9-ac04-b3ab8af2087e": { scenario: "B-nova", note: "round 4: '$500' in the answer was expanded by the shell (operator error); output truncated at 16k tokens" },
  "90c04b2e-f3b7-4a4d-aeb6-1e7ac87a36ea": { scenario: "B-nova", note: "round 5: correct answers; output truncated at 24k tokens; Nova stopped here" },
  "7d7c6857-1a80-4473-9ee3-3da1f67ca9d2": { scenario: "C-ambiguous" },
  "a4717ac3-27ef-421c-8ee8-02019eff792f": { scenario: "C-bypass" },
  "4945f2b8-09df-489f-9c21-45d459f29df7": { scenario: "unsupported" },
  "3b234302-e654-4365-b081-48c769336c8e": { scenario: "prompt-injection" },
  "3018bf99-3813-4ff9-9a97-5b315ceaf735": { scenario: "D-edit-one-value" },
  "8572946e-c465-415b-81a1-4c600de3da96": { scenario: "D-edit-precise-exception" },
};

const E2E = {
  workflowId: "3e09a87d-d279-4f44-b812-338c6bbba0ca",
  runId: "6501f281-4c9d-4cee-9238-c9fee0299da5",
  paypalOrderId: "5J050550YC544860S",
  paypalCaptureId: "16J09094P99667628",
  paypalWebhookId: "9MJ408823R309725D",
};

const shots = (dir: string) => {
  try {
    return readdirSync(path.join(OUT, dir)).filter((f) => f.endsWith(".png")).map((f) => `evidence/phase4/${dir}/${f}`);
  } catch {
    return [];
  }
};

async function main() {
  const workspaceId = await merchantWorkspaceId();
  const usage = await db().select().from(aiUsage).orderBy(asc(aiUsage.at));
  const comps = await db().select().from(aiCompilations).where(inArray(aiCompilations.id, Object.keys(SCENARIO_OF))).orderBy(asc(aiCompilations.createdAt));

  // Each compilation's calls are the usage rows recorded after the previous compilation and before it.
  let cursor = new Date(0);
  const compilations = comps.map((c) => {
    const calls = usage.filter((u) => u.at > cursor && u.at <= c.createdAt);
    cursor = c.createdAt;
    const env = c.output as { interpretation?: string; assumptions?: string[]; questions?: unknown[]; unsupported?: unknown[] } | null;
    const graph = c.graph as { nodes?: { id: string; type: string; config: unknown }[]; edges?: unknown[] } | null;
    return {
      evidenceType: "REAL_OPENAI",
      scenario: SCENARIO_OF[c.id].scenario,
      note: SCENARIO_OF[c.id].note ?? null,
      compilationId: c.id,
      kind: c.kind,
      timestamp: c.createdAt.toISOString(),
      instruction: c.instruction,
      model: calls[0]?.model ?? c.model,
      calls: calls.map((u) => ({
        purpose: u.purpose,
        inputTokens: u.inputTokens,
        cachedInputTokens: u.cacheReadTokens,
        outputTokens: u.outputTokens,
        costUsd: u.costUsd,
        ok: u.ok,
        error: u.error,
      })),
      costUsd: calls.reduce((s, u) => s + Number(u.costUsd), 0).toFixed(6),
      status: c.status,
      attempts: c.attempts,
      repairReasons: c.repairs ?? [],
      clarificationRequested: c.status === "NEEDS_CLARIFICATION",
      draftProduced: c.status === "COMPILED" || c.status === "APPLIED",
      workflowId: c.workflowId,
      resultVersionId: c.resultVersionId,
      grounding: c.grounding ?? null,
      validation: c.validation ?? null,
      changes: (c.changes as { changes?: unknown; weakened?: unknown } | null) ?? null,
      error: c.error ?? null,
      interpretation: env?.interpretation ?? null,
      assumptions: env?.assumptions ?? [],
      questions: env?.questions ?? [],
      unsupported: env?.unsupported ?? [],
      graph: graph?.nodes ? { nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, config: n.config })), edges: graph.edges } : null,
    };
  });

  const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, E2E.runId));
  const [version] = await db().select().from(workflowVersions).where(eq(workflowVersions.id, run.versionId));
  const steps = await db().select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.seq));
  const [approval] = await db().select().from(approvals).where(eq(approvals.runId, run.id));
  const [event] = await db().select().from(paypalEvents).where(eq(paypalEvents.eventId, run.triggerRef));
  const runAudit = await db().select().from(auditRecords).where(eq(auditRecords.runId, run.id)).orderBy(asc(auditRecords.seq));
  const chain = await verifyChain(workspaceId);

  const total = usage.reduce((s, u) => s + Number(u.costUsd), 0);
  const manifest = {
    generatedAt: new Date().toISOString(),
    labels: {
      REAL_OPENAI: "Produced by a real OpenAI API call (model and token usage recorded per call).",
      REAL_PAYPAL_SANDBOX: "Produced by the real PayPal Sandbox (IDs resolvable in the PayPal developer dashboard).",
      MOCK_TEST: "Produced by automated tests against a scripted provider. Never presented as real model output.",
    },
    ai: {
      provider: "openai",
      model: "gpt-5.4-mini (snapshot gpt-5.4-mini-2026-03-17)",
      reasoningEffort: "medium",
      pricingUsdPerMillion: { input: 0.75, cachedInput: 0.075, output: 4.5, source: "developers.openai.com/api/docs/pricing, 2026-10-03" },
      realCalls: usage.length,
      totalCostUsd: total.toFixed(6),
      phase4CapUsd: "1.00",
      overallBudgetUsd: "5.00",
      remainingOverallUsd: (5 - total).toFixed(6),
      inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
      cachedInputTokens: usage.reduce((s, u) => s + u.cacheReadTokens, 0),
      outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
    },
    scenarioInstructions: SCENARIOS,
    compilations,
    endToEnd: {
      evidenceType: ["REAL_OPENAI", "REAL_PAYPAL_SANDBOX"],
      workflowId: E2E.workflowId,
      versionId: version.id,
      version: version.version,
      versionProvenance: version.provenance,
      activatedAt: version.activatedAt?.toISOString(),
      activatedBy: version.activatedBy,
      paypal: {
        orderId: E2E.paypalOrderId,
        captureId: E2E.paypalCaptureId,
        amount: "2750.00 USD",
        webhookId: E2E.paypalWebhookId,
        eventId: event.eventId,
        eventType: event.eventType,
        signatureVerification: event.verification,
        provenance: event.provenance,
        receivedAt: event.receivedAt.toISOString(),
      },
      run: {
        runId: run.id,
        status: run.status,
        outcome: run.outcome,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString(),
        steps: steps.map((s) => ({ seq: s.seq, node: s.nodeId, type: s.nodeType, port: s.port, explanation: s.explanation, at: s.startedAt.toISOString() })),
      },
      approval: approval ? { id: approval.id, status: approval.status, reason: approval.reason, decidedAt: approval.decidedAt?.toISOString(), note: approval.note } : null,
      audit: runAudit.map((a) => ({ seq: a.seq, at: a.at.toISOString(), kind: a.kind, summary: a.summary, hash: a.hash })),
      auditChain: chain,
    },
    recordings: {
      note: "Screenshot sequences captured from the real UI (headless Microsoft Edge, 1920×1080). Videos are to be recorded manually; see README.",
      "A-ai-compilation": shots("simple"),
      "B-complex-nova": shots("nova"),
      "C-safety": [...shots("ambiguous"), ...shots("bypass"), ...shots("unsupported"), ...shots("injection")],
      "D-natural-language-editing": [...shots("edit-modify"), ...shots("edit-precise")],
      "E-end-to-end-paypal": shots("e2e"),
      summary: shots("summary"),
    },
    mockTests: {
      evidenceType: "MOCK_TEST",
      note: "The ten Phase 4 scenario categories are also covered deterministically by tests/compiler.test.ts, tests/openai-provider.test.ts and tests/anthropic-provider.test.ts against a scripted provider. Those results are not model output.",
    },
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`manifest: ${compilations.length} compilations, ${usage.length} real calls, $${total.toFixed(4)}, chain ${chain.ok ? "intact" : "BROKEN"}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
