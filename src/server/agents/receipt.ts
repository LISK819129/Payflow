import { and, eq, sql } from "drizzle-orm";
import { appendAudit } from "../audit/audit";
import { canonicalJson, sha256Hex } from "../audit/canonical";
import type { DbOrTx, Tx } from "../db/client";
import { agentRequests, auditRecords } from "../db/schema";
import type { Envelope } from "./envelope";

/**
 * Intent Receipt: a machine-readable, canonicalised record of exactly what an
 * agent asked PayFlow to do, written once when the request is accepted.
 *
 * It is not a contract. It answers "what did the agent ask for?" so that the
 * payment PayFlow later makes can be bound to it, and anyone can check that
 * neither has changed. Evidence documents are referenced by SHA-256 only.
 *
 * What happened next (authority decision, human decision, PayPal result) is
 * recorded as a hash chain of links anchored on the receipt hash. The receipt
 * hash and every link hash are also written into the workspace's audit chain,
 * so rewriting a receipt together with its stored hash is still detected.
 */
export type IntentReceipt = {
  type: "payflow.intent_receipt";
  version: 1;
  receipt_id: string;
  issued_at: string;
  mode: "LIVE" | "TEST";
  requester: { kind: "ai_agent"; agent_id: string; agent_name: string; owner_user_id: string; credential_version: number; authenticated_by: "bearer_credential" };
  request: {
    request_id: string;
    action: string;
    amount: { value: string; currency: string };
    counterparty: string | null;
    capture_id: string | null;
    purpose: string;
    reference: string | null;
  };
  evidence: { kind: "invoice_text" | "contract_text"; sha256: string; chars: number }[];
  workflow: { id: string; name: string; version_id: string; version: number; graph_hash: string };
  authority_at_acceptance: { id: string; name: string; version: number; status: string }[];
  request_hash: string;
  statement: string;
};

export type ReceiptLink = { seq: number; kind: string; key: string; at: string; data: Record<string, unknown>; prev: string; hash: string };

export function buildReceipt(x: {
  reference: string;
  issuedAt: Date;
  envelope: Envelope;
  requestId: string;
  agent: { id: string; name: string; ownerId: string; credentialVersion: number };
  workflow: { id: string; name: string; versionId: string; version: number; graph: unknown };
  authorities: { id: string; name: string; version: number; status: string }[];
  requestHash: string;
}): IntentReceipt {
  const e = x.envelope;
  const evidence: IntentReceipt["evidence"] = [];
  if (e.evidence.invoiceText) evidence.push({ kind: "invoice_text", sha256: sha256Hex(e.evidence.invoiceText), chars: e.evidence.invoiceText.length });
  if (e.evidence.contractText) evidence.push({ kind: "contract_text", sha256: sha256Hex(e.evidence.contractText), chars: e.evidence.contractText.length });
  const g = x.workflow.graph as { nodes: unknown; edges: unknown };
  return {
    type: "payflow.intent_receipt",
    version: 1,
    receipt_id: x.reference,
    issued_at: x.issuedAt.toISOString(),
    mode: e.mode,
    requester: { kind: "ai_agent", agent_id: x.agent.id, agent_name: x.agent.name, owner_user_id: x.agent.ownerId, credential_version: x.agent.credentialVersion, authenticated_by: "bearer_credential" },
    request: { request_id: x.requestId, action: e.action, amount: e.amount, counterparty: e.counterparty, capture_id: e.captureId, purpose: e.purpose, reference: e.reference },
    evidence,
    workflow: { id: x.workflow.id, name: x.workflow.name, version_id: x.workflow.versionId, version: x.workflow.version, graph_hash: sha256Hex(canonicalJson({ nodes: g.nodes, edges: g.edges })) },
    authority_at_acceptance: x.authorities,
    request_hash: x.requestHash,
    statement:
      e.mode === "TEST"
        ? "TEST request: evaluated in isolation. It cannot move money and can never become a live request."
        : "This records what the agent asked for. It authorizes nothing: PayFlow's authority, intelligence and, where required, a person decide.",
  };
}

export const receiptHash = (r: unknown) => sha256Hex(canonicalJson(r));

function linkHash(prev: string, l: Omit<ReceiptLink, "hash" | "prev">) {
  return sha256Hex(prev + "\n" + canonicalJson({ seq: l.seq, kind: l.kind, key: l.key, at: l.at, data: l.data }));
}

/**
 * Appends links that are not there yet (by key) to a request row the caller
 * has locked FOR UPDATE, and anchors each new hash in the audit chain.
 */
export async function appendLinks(
  tx: Tx,
  row: { id: string; workspaceId: string; reference: string; receiptHash: string; links: unknown; runId: string | null },
  add: { kind: string; key: string; at: Date; data: Record<string, unknown> }[],
): Promise<ReceiptLink[]> {
  const links = [...(row.links as ReceiptLink[])];
  const fresh: ReceiptLink[] = [];
  for (const a of add) {
    if (links.some((l) => l.key === a.key)) continue;
    const prev = links.length ? links[links.length - 1].hash : row.receiptHash;
    const base = { seq: links.length + 1, kind: a.kind, key: a.key, at: new Date(Math.floor(a.at.getTime())).toISOString(), data: a.data };
    const link: ReceiptLink = { ...base, prev, hash: linkHash(prev, base) };
    links.push(link);
    fresh.push(link);
  }
  if (!fresh.length) return [];
  await tx.update(agentRequests).set({ links, updatedAt: new Date() }).where(eq(agentRequests.id, row.id));
  for (const l of fresh) {
    await appendAudit(tx, {
      workspaceId: row.workspaceId,
      actor: "system",
      kind: "agent.receipt.linked",
      summary: `Intent receipt ${row.reference} · ${l.kind.replaceAll("_", " ")}`,
      payload: { reference: row.reference, seq: l.seq, kind: l.kind, hash: l.hash },
      runId: row.runId,
    });
  }
  return fresh;
}

export type ReceiptVerification = { ok: boolean; problems: string[]; receiptHash: string; links: number };

/** Recomputes the receipt hash and the link chain, and checks both against the audit chain's anchors. */
export async function verifyReceipt(handle: DbOrTx, row: { workspaceId: string; reference: string; receipt: unknown; receiptHash: string; links: unknown }): Promise<ReceiptVerification> {
  const problems: string[] = [];
  const recomputed = receiptHash(row.receipt);
  if (recomputed !== row.receiptHash) problems.push("receipt content does not match its hash");
  const anchors = await handle
    .select({ kind: auditRecords.kind, payload: auditRecords.payload })
    .from(auditRecords)
    .where(and(eq(auditRecords.workspaceId, row.workspaceId), sql`${auditRecords.kind} in ('agent.request.accepted','agent.receipt.linked')`, sql`${auditRecords.payload}->>'reference' = ${row.reference}`));
  const accepted = anchors.find((a) => a.kind === "agent.request.accepted");
  if (!accepted) problems.push("no acceptance record in the audit chain");
  else if ((accepted.payload as { receiptHash?: string }).receiptHash !== recomputed) problems.push("receipt differs from the one anchored in the audit chain");
  const links = row.links as ReceiptLink[];
  let prev = recomputed;
  links.forEach((l, i) => {
    if (l.seq !== i + 1) problems.push(`link ${i + 1} is out of order`);
    if (l.prev !== prev) problems.push(`link ${l.seq} does not follow the previous one`);
    const h = linkHash(prev, l);
    if (h !== l.hash) problems.push(`link ${l.seq} (${l.kind}) was changed`);
    const anchored = anchors.some((a) => a.kind === "agent.receipt.linked" && (a.payload as { seq?: number; hash?: string }).seq === l.seq && (a.payload as { hash?: string }).hash === h);
    if (!anchored) problems.push(`link ${l.seq} (${l.kind}) is not anchored in the audit chain`);
    prev = h;
  });
  return { ok: problems.length === 0, problems, receiptHash: recomputed, links: links.length };
}
