import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../db/client";
import { db } from "../db/client";
import { auditRecords } from "../db/schema";
import { canonicalJson, sha256Hex } from "./canonical";

export const GENESIS_HASH = "GENESIS";

export type AuditInput = {
  workspaceId: string;
  actor: string;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  workflowId?: string | null;
  runId?: string | null;
  paypalRef?: string | null;
  at?: Date;
};

type HashedFields = {
  workspaceId: string;
  seq: number;
  at: Date;
  actor: string;
  kind: string;
  summary: string;
  payload: unknown;
  workflowId: string | null;
  runId: string | null;
  paypalRef: string | null;
  prevHash: string;
};

export function hashRecord(r: HashedFields): string {
  return sha256Hex(
    canonicalJson({
      workspaceId: r.workspaceId,
      seq: r.seq,
      at: r.at.toISOString(),
      actor: r.actor,
      kind: r.kind,
      summary: r.summary,
      payload: r.payload ?? {},
      workflowId: r.workflowId,
      runId: r.runId,
      paypalRef: r.paypalRef,
      prevHash: r.prevHash,
    }),
  );
}

/**
 * Append one record to the workspace's chain. Must run inside a transaction so
 * the audit record commits atomically with the state change it describes; the
 * advisory lock serialises appends per workspace so `seq` has no gaps or forks.
 */
export async function appendAudit(tx: Tx, input: AuditInput) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"audit:" + input.workspaceId}))`);
  const [last] = await tx
    .select({ seq: auditRecords.seq, hash: auditRecords.hash })
    .from(auditRecords)
    .where(eq(auditRecords.workspaceId, input.workspaceId))
    .orderBy(desc(auditRecords.seq))
    .limit(1);

  // Millisecond precision, matching the column, so the hash survives a round trip.
  const at = new Date(Math.floor((input.at ?? new Date()).getTime()));
  const fields: HashedFields = {
    workspaceId: input.workspaceId,
    seq: (last?.seq ?? 0) + 1,
    at,
    actor: input.actor,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload ?? {},
    workflowId: input.workflowId ?? null,
    runId: input.runId ?? null,
    paypalRef: input.paypalRef ?? null,
    prevHash: last?.hash ?? GENESIS_HASH,
  };
  const hash = hashRecord(fields);
  const [row] = await tx
    .insert(auditRecords)
    .values({ ...fields, payload: fields.payload as Record<string, unknown>, hash })
    .returning();
  return row;
}

/** Convenience for callers with no surrounding transaction. */
export async function audit(input: AuditInput) {
  return db().transaction((tx) => appendAudit(tx, input));
}

export type ChainVerification =
  | { ok: true; records: number; head: string }
  | { ok: false; records: number; brokenAtSeq: number; reason: string };

/** Recompute every hash in order. Streams in pages to keep memory flat. */
export async function verifyChain(workspaceId: string, handle: DbOrTx = db()): Promise<ChainVerification> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let count = 0;
  const pageSize = 1000;
  for (;;) {
    const page = await handle
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.workspaceId, workspaceId), gt(auditRecords.seq, expectedSeq - 1)))
      .orderBy(asc(auditRecords.seq))
      .limit(pageSize);
    for (const r of page) {
      if (r.seq !== expectedSeq) {
        return { ok: false, records: count, brokenAtSeq: expectedSeq, reason: `missing record (found seq ${r.seq})` };
      }
      if (r.prevHash !== prevHash) {
        return { ok: false, records: count, brokenAtSeq: r.seq, reason: "prevHash does not match previous record" };
      }
      if (hashRecord(r) !== r.hash) {
        return { ok: false, records: count, brokenAtSeq: r.seq, reason: "record contents do not match its hash" };
      }
      prevHash = r.hash;
      expectedSeq += 1;
      count += 1;
    }
    if (page.length < pageSize) break;
  }
  return { ok: true, records: count, head: prevHash };
}
