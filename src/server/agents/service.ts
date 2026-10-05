import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { db } from "../db/client";
import { agentRequests, agents, approvals, authorities, users, workflows, workflowVersions, type AgentScope } from "../db/schema";
import { periodWindow } from "../authority/periods";
import { scopeKeyFor } from "../authority/internal";
import { usageFor } from "../authority/ledger";
import { simulate } from "../simulation/run";
import { SPEC_BY_TYPE, type WorkflowGraph } from "../workflow/dsl/nodes";
import { startRunTx } from "../workflow/runtime/engine";
import type { RuntimeDeps } from "../workflow/runtime/types";
import { credentialHint, issueCredential, parseBearer, secretMatches } from "./credentials";
import { requestHash, triggerPayload, type Envelope } from "./envelope";
import { buildReceipt, receiptHash } from "./receipt";
import { statusView, syncAgentRequest, type StatusView } from "./status";

export type AgentRow = typeof agents.$inferSelect;
export type AgentContext = { agent: AgentRow };

export type GatewayErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIAL"
  | "AGENT_REVOKED"
  | "AGENT_EXPIRED"
  | "INVALID_REQUEST"
  | "WORKFLOW_NOT_IN_SCOPE"
  | "ACTION_NOT_IN_SCOPE"
  | "MODE_NOT_IN_SCOPE"
  | "WORKFLOW_NOT_AVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "NOT_CANCELLABLE"
  | "RATE_LIMITED";

export type GatewayError = { ok: false; code: GatewayErrorCode; message: string };
const fail = (code: GatewayErrorCode, message: string): GatewayError => ({ ok: false, code, message });

/** What an agent can never do, whatever its scope. Shown to agents and owners alike. */
export const NEVER = [
  "approve or reject any request (including its own)",
  "create, edit or suspend authorities, budgets or allowlists",
  "create, edit, activate or pause workflows",
  "call PayPal directly or reach any PayPal endpoint",
  "see credentials, secrets or other agents",
  "turn a TEST request into a live one",
];

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * Authenticates one call. Status and expiry are read from the database every
 * time, so revocation and expiry take effect on the very next call.
 */
export async function authenticateAgent(authorization: string | null, now = new Date()): Promise<{ ok: true; agent: AgentRow } | GatewayError> {
  if (!authorization) return fail("UNAUTHENTICATED", "Missing bearer credential");
  const parsed = parseBearer(authorization);
  if (!parsed) return fail("INVALID_CREDENTIAL", "Malformed or unknown credential");
  const [agent] = await db().select().from(agents).where(eq(agents.credentialId, parsed.credentialId));
  if (!agent || !secretMatches(parsed.secret, agent.credentialHash)) {
    if (agent) await recordAuthFailure(agent, "INVALID_CREDENTIAL");
    return fail("INVALID_CREDENTIAL", "Malformed or unknown credential");
  }
  if (agent.status !== "ACTIVE") {
    await recordAuthFailure(agent, "AGENT_REVOKED");
    return fail("AGENT_REVOKED", "This agent has been revoked");
  }
  if (agent.expiresAt && agent.expiresAt <= now) {
    await recordAuthFailure(agent, "AGENT_EXPIRED");
    return fail("AGENT_EXPIRED", "This agent's access has expired");
  }
  return { ok: true, agent };
}

const lastFailureAudit = new Map<string, number>();
/** A known agent presenting a bad, revoked or expired credential: audited (at most once a minute per agent). */
async function recordAuthFailure(agent: AgentRow, code: string) {
  const key = `${agent.id}:${code}`;
  if ((lastFailureAudit.get(key) ?? 0) > Date.now() - 60_000) return;
  lastFailureAudit.set(key, Date.now());
  await db().transaction((tx) =>
    appendAudit(tx, {
      workspaceId: agent.workspaceId,
      actor: `agent:${agent.id}`,
      kind: "agent.auth.refused",
      summary: `Agent “${agent.name}” refused: ${code.replaceAll("_", " ").toLowerCase()}`,
      payload: { agentId: agent.id, code, credential: credentialHint(agent.credentialId) },
    }),
  );
}

export async function touchAgent(agentId: string, tool: string) {
  await db().update(agents).set({ lastUsedAt: new Date(), lastUsedTool: tool }).where(eq(agents.id, agentId));
}

// ── Registration (owner actions, from the PayFlow UI) ──────────────────────

const ACTIONS = new Set(["paypal.payout", "paypal.refund"]);

async function validScopes(workspaceId: string, scopes: AgentScope[]): Promise<string | null> {
  if (!scopes.length) return "Choose at least one workflow the agent may request through";
  const ids = scopes.map((s) => s.workflowId);
  const found = await db().select({ id: workflows.id }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), inArray(workflows.id, ids)));
  if (found.length !== new Set(ids).size) return "Unknown workflow in scope";
  for (const s of scopes) {
    if (!s.actions.length || s.actions.some((a) => !ACTIONS.has(a))) return "Each scope needs at least one of: payout, refund";
    if (!s.modes.length || s.modes.some((m) => m !== "LIVE" && m !== "TEST")) return "Each scope needs LIVE and/or TEST";
  }
  return null;
}

export async function registerAgent(input: { workspaceId: string; userId: string; name: string; description?: string; scopes: AgentScope[]; expiresAt?: Date | null }) {
  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) return { ok: false as const, error: "Name must be 3–80 characters" };
  const bad = await validScopes(input.workspaceId, input.scopes);
  if (bad) return { ok: false as const, error: bad };
  const cred = issueCredential();
  const agent = await db().transaction(async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        workspaceId: input.workspaceId,
        name,
        description: input.description?.trim() || null,
        ownerId: input.userId,
        scopes: input.scopes,
        credentialId: cred.credentialId,
        credentialHash: cred.credentialHash,
        expiresAt: input.expiresAt ?? null,
        createdBy: input.userId,
      })
      .returning();
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "agent.registered",
      summary: `Agent “${name}” registered; may request ${input.scopes.map((s) => s.actions.map((x) => x.replace("paypal.", "")).join("/")).join(", ")}`,
      payload: { agentId: a.id, scopes: input.scopes, expiresAt: input.expiresAt?.toISOString() ?? null, credential: credentialHint(cred.credentialId) },
    });
    return a;
  });
  return { ok: true as const, agent, token: cred.token };
}

export async function rotateCredential(input: { workspaceId: string; userId: string; agentId: string }) {
  const cred = issueCredential();
  const r = await db().transaction(async (tx) => {
    const [a] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, input.workspaceId))).for("update");
    if (!a) return { ok: false as const, error: "Agent not found" };
    if (a.status !== "ACTIVE") return { ok: false as const, error: "A revoked agent cannot be given a new credential" };
    await tx
      .update(agents)
      .set({ credentialId: cred.credentialId, credentialHash: cred.credentialHash, credentialVersion: a.credentialVersion + 1, credentialIssuedAt: new Date() })
      .where(eq(agents.id, a.id));
    await appendAudit(tx, {
      workspaceId: a.workspaceId,
      actor: `user:${input.userId}`,
      kind: "agent.credential.rotated",
      summary: `Agent “${a.name}” credential rotated (v${a.credentialVersion} → v${a.credentialVersion + 1}); the old one stopped working immediately`,
      payload: { agentId: a.id, from: credentialHint(a.credentialId), to: credentialHint(cred.credentialId), version: a.credentialVersion + 1 },
    });
    return { ok: true as const };
  });
  return r.ok ? { ok: true as const, token: cred.token } : r;
}

/**
 * Revokes an agent. Its next call fails; any of its requests still waiting for
 * a person are withdrawn; anything already approved is stopped before PayPal
 * by the execution preflight (the agent must be active at send time).
 */
export async function revokeAgent(input: { workspaceId: string; userId: string; agentId: string; reason?: string }, deps: Pick<RuntimeDeps, "enqueueAdvance">) {
  const wake: string[] = [];
  const r = await db().transaction(async (tx) => {
    const [a] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, input.workspaceId))).for("update");
    if (!a) return { ok: false as const, error: "Agent not found" };
    if (a.status === "REVOKED") return { ok: false as const, error: "Already revoked" };
    await tx.update(agents).set({ status: "REVOKED", revokedAt: new Date(), revokedBy: input.userId, revokeReason: input.reason?.slice(0, 300) ?? null }).where(eq(agents.id, a.id));
    const open = await tx.select().from(agentRequests).where(and(eq(agentRequests.agentId, a.id), eq(agentRequests.mode, "LIVE")));
    let withdrawn = 0;
    for (const ar of open) {
      if (!ar.runId) continue;
      const changed = await tx
        .update(approvals)
        .set({ status: "REJECTED", decidedAt: new Date(), note: "Withdrawn: the requesting agent was revoked" })
        .where(and(eq(approvals.runId, ar.runId), eq(approvals.status, "PENDING")))
        .returning({ id: approvals.id });
      if (changed.length) {
        withdrawn++;
        wake.push(ar.runId);
        await tx.update(agentRequests).set({ state: "CANCELLED", updatedAt: new Date() }).where(eq(agentRequests.id, ar.id));
      }
    }
    await appendAudit(tx, {
      workspaceId: a.workspaceId,
      actor: `user:${input.userId}`,
      kind: "agent.revoked",
      summary: `Agent “${a.name}” revoked${withdrawn ? `; ${withdrawn} waiting request(s) withdrawn` : ""}`,
      payload: { agentId: a.id, reason: input.reason ?? null, withdrawn },
    });
    return { ok: true as const };
  });
  for (const runId of wake) await deps.enqueueAdvance(runId);
  return r;
}

// ── Requests (agent actions, from the MCP server) ──────────────────────────

function newReference() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `PF-${[...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

/** The workflow, its active version and the authorities covering it — or why an agent may not use it. */
async function resolveTarget(agent: AgentRow, e: Envelope) {
  const scope = agent.scopes.find((s) => s.workflowId === e.workflowId);
  if (!scope) return fail("WORKFLOW_NOT_IN_SCOPE", "This agent may not request through that workflow");
  if (!scope.actions.includes(e.action)) return fail("ACTION_NOT_IN_SCOPE", `This agent may not request a ${e.action.replace("paypal.", "")}`);
  if (!scope.modes.includes(e.mode)) return fail("MODE_NOT_IN_SCOPE", `This agent may not make ${e.mode} requests`);
  const [wf] = await db().select().from(workflows).where(and(eq(workflows.id, e.workflowId), eq(workflows.workspaceId, agent.workspaceId)));
  if (!wf || wf.state !== "ACTIVE" || !wf.activeVersionId) return fail("WORKFLOW_NOT_AVAILABLE", "That workflow is not active");
  const [version] = await db().select().from(workflowVersions).where(eq(workflowVersions.id, wf.activeVersionId));
  const graph = version.graph as WorkflowGraph;
  const trigger = graph.nodes.find((n) => SPEC_BY_TYPE[n.type]?.category === "trigger");
  if (trigger?.type !== "trigger.agent_request") return fail("WORKFLOW_NOT_AVAILABLE", "That workflow does not accept agent requests");
  const accepts = (trigger.config as { actions?: string[] }).actions;
  if ((accepts && !accepts.includes(e.action)) || !graph.nodes.some((n) => n.type === e.action)) {
    return fail("WORKFLOW_NOT_AVAILABLE", `That workflow does not carry out a ${e.action.replace("paypal.", "")}`);
  }
  const auths = await db()
    .select({ id: authorities.id, name: authorities.name, version: authorities.version, status: authorities.status })
    .from(authorities)
    .where(and(eq(authorities.workspaceId, agent.workspaceId), sql`${authorities.workflowIds} @> ${JSON.stringify([wf.id])}::jsonb`));
  return { ok: true as const, wf, version, authorities: auths };
}

class Refused extends Error {
  constructor(readonly error: GatewayError) {
    super(error.message);
  }
}

export type SubmitResult = { ok: true; replayed: boolean; status: StatusView } | GatewayError;

/**
 * Accepts an agent request into the normal engine. LIVE: one run of the
 * workflow's active version, created atomically with the request and its
 * receipt. TEST: Phase 8's isolated Test Run — no run, no PayPal capability.
 *
 * Idempotency: (agent, request_id) is unique. The same request again returns
 * the existing PayFlow request; a different request under the same id is an
 * IDEMPOTENCY_CONFLICT. Concurrent duplicates serialise on the unique index.
 */
export async function submitAgentRequest(ctx: AgentContext, requestId: string, e: Envelope, deps: RuntimeDeps): Promise<SubmitResult> {
  const hash = requestHash(e);
  const replay = async (): Promise<SubmitResult | null> => {
    const [existing] = await db().select().from(agentRequests).where(and(eq(agentRequests.agentId, ctx.agent.id), eq(agentRequests.requestId, requestId)));
    if (!existing) return null;
    if (existing.requestHash !== hash) {
      return fail("IDEMPOTENCY_CONFLICT", `request_id ${requestId} was already used for a different request (${existing.reference}); use a new request_id for a new request`);
    }
    return { ok: true, replayed: true, status: await statusView((await syncAgentRequest(existing.id)) ?? existing) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const target = await resolveTarget(ctx.agent, e);
  if (!target.ok) return target;
  const { wf, version } = target;

  let created: typeof agentRequests.$inferSelect | null = null;
  let runId: string | null = null;
  try {
    created = await db().transaction(async (tx) => {
      // Revocation takes this row FOR UPDATE: a request is accepted only while the agent is active.
      const [agent] = await tx.select().from(agents).where(eq(agents.id, ctx.agent.id)).for("share");
      if (!agent || agent.status !== "ACTIVE") throw new Refused(fail("AGENT_REVOKED", "This agent has been revoked"));
      if (agent.expiresAt && agent.expiresAt <= new Date()) throw new Refused(fail("AGENT_EXPIRED", "This agent's access has expired"));
      const reference = newReference();
      const issuedAt = new Date();
      const receipt = buildReceipt({
        reference,
        issuedAt,
        envelope: e,
        requestId,
        agent: { id: agent.id, name: agent.name, ownerId: agent.ownerId, credentialVersion: agent.credentialVersion },
        workflow: { id: wf.id, name: wf.name, versionId: version.id, version: version.version, graph: version.graph },
        authorities: target.authorities,
        requestHash: hash,
      });
      const rHash = receiptHash(receipt);
      const [row] = await tx
        .insert(agentRequests)
        .values({
          reference,
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          requestId,
          mode: e.mode,
          requestHash: hash,
          envelope: e,
          workflowId: wf.id,
          versionId: version.id,
          state: e.mode === "TEST" ? "PROCESSING" : "ACCEPTED",
          receipt,
          receiptHash: rHash,
        })
        .onConflictDoNothing({ target: [agentRequests.agentId, agentRequests.requestId] })
        .returning();
      if (!row) return null; // a concurrent duplicate won; answered as a replay below
      await appendAudit(tx, {
        workspaceId: agent.workspaceId,
        actor: `agent:${agent.id}`,
        kind: "agent.request.accepted",
        summary: `${e.mode === "TEST" ? "TEST request" : "Request"} ${reference} from agent “${agent.name}”: ${e.action.replace("paypal.", "")} ${e.amount.value} ${e.amount.currency}${e.counterparty ? ` → ${e.counterparty}` : ""}${e.captureId ? ` · capture ${e.captureId}` : ""} — accepted for evaluation, not authorized`,
        payload: { reference, requestId, mode: e.mode, requestHash: hash, receiptHash: rHash, workflowId: wf.id, versionId: version.id },
        workflowId: wf.id,
      });
      if (e.mode === "LIVE") {
        const run = await startRunTx(tx, {
          workflowId: wf.id,
          triggerKind: "agent_request",
          triggerRef: `agent:${row.id}`,
          triggerPayload: triggerPayload(e, { agentRequestId: row.id, reference, agent: { id: agent.id, name: agent.name } }),
          provenance: "AGENT_REQUEST",
          expectVersionId: version.id,
        });
        if (!("runId" in run)) throw new Refused(fail("WORKFLOW_NOT_AVAILABLE", `Workflow not available: ${run.skipped}`));
        runId = run.runId;
        await tx.update(agentRequests).set({ runId: run.runId }).where(eq(agentRequests.id, row.id));
        return { ...row, runId: run.runId };
      }
      return row;
    });
  } catch (err) {
    if (err instanceof Refused) return err.error;
    throw err;
  }
  if (!created) return (await replay()) ?? fail("IDEMPOTENCY_CONFLICT", "Concurrent request with the same request_id");

  if (runId) await deps.enqueueAdvance(runId);
  if (e.mode === "TEST") {
    const sim = await simulate({
      mode: "TEST",
      workspaceId: ctx.agent.workspaceId,
      workflowId: wf.id,
      versionId: version.id,
      trigger: { kind: "agent_request", payload: triggerPayload(e, { agentRequestId: created.id, reference: created.reference, agent: { id: ctx.agent.id, name: ctx.agent.name } }) },
      userId: null,
    });
    if (sim.ok) await db().update(agentRequests).set({ simulationId: sim.id }).where(eq(agentRequests.id, created.id));
  }
  const synced = (await syncAgentRequest(created.id)) ?? created;
  return { ok: true, replayed: false, status: await statusView(synced) };
}

export async function getAgentRequest(ctx: AgentContext, ref: { reference?: string; requestId?: string }) {
  const where = ref.reference ? eq(agentRequests.reference, ref.reference) : eq(agentRequests.requestId, ref.requestId ?? "");
  // An agent sees only its own requests; anything else is indistinguishable from "not found".
  const [ar] = await db().select().from(agentRequests).where(and(where, eq(agentRequests.agentId, ctx.agent.id)));
  if (!ar) return fail("NOT_FOUND", "No such request for this agent");
  const synced = (await syncAgentRequest(ar.id)) ?? ar;
  return { ok: true as const, status: await statusView(synced), receipt: synced.receipt };
}

/** An agent may withdraw its own request while it waits for a person — never approve it. */
export async function cancelAgentRequest(ctx: AgentContext, reference: string, deps: Pick<RuntimeDeps, "enqueueAdvance">) {
  const r = await db().transaction(async (tx) => {
    const [ar] = await tx.select().from(agentRequests).where(and(eq(agentRequests.reference, reference), eq(agentRequests.agentId, ctx.agent.id))).for("update");
    if (!ar) return fail("NOT_FOUND", "No such request for this agent");
    if (ar.mode !== "LIVE" || !ar.runId) return fail("NOT_CANCELLABLE", "Only a live request waiting for review can be withdrawn");
    const changed = await tx
      .update(approvals)
      .set({ status: "REJECTED", decidedAt: new Date(), note: "Withdrawn by the requesting agent" })
      .where(and(eq(approvals.runId, ar.runId), eq(approvals.status, "PENDING")))
      .returning({ id: approvals.id });
    if (!changed.length) return fail("NOT_CANCELLABLE", "Only a request waiting for review can be withdrawn; this one is not");
    await tx.update(agentRequests).set({ state: "CANCELLED", updatedAt: new Date() }).where(eq(agentRequests.id, ar.id));
    await appendAudit(tx, {
      workspaceId: ar.workspaceId,
      actor: `agent:${ctx.agent.id}`,
      kind: "agent.request.withdrawn",
      summary: `Agent “${ctx.agent.name}” withdrew ${ar.reference} before review; PayPal was not contacted`,
      payload: { reference: ar.reference, approvalId: changed[0].id },
      runId: ar.runId,
    });
    return { ok: true as const, id: ar.id, runId: ar.runId };
  });
  if (!r.ok) return r;
  await deps.enqueueAdvance(r.runId);
  const synced = await syncAgentRequest(r.id);
  return { ok: true as const, status: await statusView(synced!) };
}

/** The agent's own identity and scope, and the authority limits it operates under (read-only). */
export async function listCapabilities(ctx: AgentContext) {
  const a = ctx.agent;
  const ids = a.scopes.map((s) => s.workflowId);
  const wfs = ids.length ? await db().select().from(workflows).where(and(eq(workflows.workspaceId, a.workspaceId), inArray(workflows.id, ids))) : [];
  return {
    agent: { id: a.id, name: a.name, status: a.status, expires_at: a.expiresAt?.toISOString() ?? null, credential_version: a.credentialVersion },
    can_request: a.scopes.map((s) => {
      const w = wfs.find((x) => x.id === s.workflowId);
      return { workflow_id: s.workflowId, workflow_name: w?.name ?? "(unavailable)", workflow_active: w?.state === "ACTIVE", actions: s.actions.map((x) => x.replace("paypal.", "")), modes: s.modes };
    }),
    cannot: NEVER,
    principle: "Requesting is not authorization. Every request is decided by PayFlow's authority, intelligence and, where required, a person; PayPal settles only after that.",
    states: {
      live: ["ACCEPTED", "PROCESSING", "REVIEW_REQUIRED", "APPROVED", "REJECTED", "DENIED", "CANCELLED", "SUBMITTED_TO_PAYPAL", "AWAITING_RECIPIENT", "COMPLETED", "RETURNED", "FAILED", "UNKNOWN", "ENDED"],
      test: ["TEST_COMPLETE"],
      settled_only_when: "COMPLETED — PayPal confirmed the money reached its destination",
    },
  };
}

export async function authoritySummary(ctx: AgentContext, workflowId: string) {
  if (!ctx.agent.scopes.some((s) => s.workflowId === workflowId)) return fail("WORKFLOW_NOT_IN_SCOPE", "This agent may not request through that workflow");
  const rows = await db()
    .select()
    .from(authorities)
    .where(and(eq(authorities.workspaceId, ctx.agent.workspaceId), sql`${authorities.workflowIds} @> ${JSON.stringify([workflowId])}::jsonb`))
    .orderBy(desc(authorities.updatedAt));
  const now = new Date();
  const out = [];
  for (const a of rows) {
    let budget = null;
    if (a.budgetAmount && a.budgetPeriod) {
      const w = periodWindow(a.budgetPeriod, now);
      const u = await db().transaction((tx) => usageFor(tx, a.workspaceId, scopeKeyFor(a.id), w));
      budget = { limit: a.budgetAmount, period: w.label, committed: u.committed, reserved: u.reserved };
    }
    out.push({
      name: a.name,
      version: a.version,
      status: a.status,
      actions: a.actions.map((x) => x.replace("paypal.", "")),
      currencies: a.currencies,
      per_transaction_max: a.perTransactionMax,
      counterparties: a.counterpartyRule === "any" ? "any (except denied)" : a.counterparties.map((c) => c.id),
      purpose_scope: a.purposeScope,
      budget,
      valid_until: a.expiresAt?.toISOString() ?? null,
    });
  }
  return { ok: true as const, workflow_id: workflowId, authorities: out, note: "Read-only. Agents cannot change authority; amounts over these limits go to a person." };
}

export async function ownerOf(agentId: string) {
  const [r] = await db().select({ email: users.email }).from(agents).innerJoin(users, eq(users.id, agents.ownerId)).where(eq(agents.id, agentId));
  return r?.email ?? null;
}
