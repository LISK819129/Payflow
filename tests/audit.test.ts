import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, audit, verifyChain } from "@/server/audit/audit";
import { closeDb, db } from "@/server/db/client";
import { auditRecords } from "@/server/db/schema";
import { createWorkspace, resetTestDb } from "./support/db";

describe("audit chain", () => {
  beforeEach(resetTestDb);
  afterAll(closeDb);

  it("links records and verifies", async () => {
    const ws = await createWorkspace();
    await audit({ workspaceId: ws.id, actor: "system", kind: "a", summary: "first", payload: { b: 2, a: 1 } });
    await audit({ workspaceId: ws.id, actor: "user:x", kind: "b", summary: "second" });
    await audit({ workspaceId: ws.id, actor: "paypal", kind: "c", summary: "third", paypalRef: "CAP-1" });

    const rows = await db().select().from(auditRecords).where(eq(auditRecords.workspaceId, ws.id));
    expect(rows.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
    expect(await verifyChain(ws.id)).toMatchObject({ ok: true, records: 3 });
  });

  it("assigns gapless sequence numbers under concurrent appends", async () => {
    const ws = await createWorkspace();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db().transaction((tx) => appendAudit(tx, { workspaceId: ws.id, actor: "system", kind: "k", summary: `n${i}` })),
      ),
    );
    expect(await verifyChain(ws.id)).toMatchObject({ ok: true, records: 20 });
  });

  it("detects an edited payload", async () => {
    const ws = await createWorkspace();
    await audit({ workspaceId: ws.id, actor: "system", kind: "a", summary: "approve $149", payload: { amount: "149.00" } });
    await audit({ workspaceId: ws.id, actor: "system", kind: "b", summary: "next" });

    await db().execute(
      sql`update audit_records set payload = '{"amount":"1490.00"}'::jsonb where workspace_id = ${ws.id} and seq = 1`,
    );
    expect(await verifyChain(ws.id)).toMatchObject({ ok: false, brokenAtSeq: 1 });
  });

  it("detects a deleted record", async () => {
    const ws = await createWorkspace();
    for (const s of ["one", "two", "three"]) await audit({ workspaceId: ws.id, actor: "system", kind: "k", summary: s });
    await db().execute(sql`delete from audit_records where workspace_id = ${ws.id} and seq = 2`);
    expect(await verifyChain(ws.id)).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("stores and verifies non-ASCII text (database must be UTF8)", async () => {
    const ws = await createWorkspace("Ünïcode Studio");
    await audit({ workspaceId: ws.id, actor: "system", kind: "k", summary: "Nova Labs → PixelForge · ₹ € ✓", payload: { note: "naïve café — 日本" } });
    expect(await verifyChain(ws.id)).toMatchObject({ ok: true, records: 1 });
  });

  it("keeps chains of different workspaces independent", async () => {
    const a = await createWorkspace("A");
    const b = await createWorkspace("B");
    await audit({ workspaceId: a.id, actor: "system", kind: "k", summary: "a1" });
    await audit({ workspaceId: b.id, actor: "system", kind: "k", summary: "b1" });
    await audit({ workspaceId: a.id, actor: "system", kind: "k", summary: "a2" });
    expect(await verifyChain(a.id)).toMatchObject({ ok: true, records: 2 });
    expect(await verifyChain(b.id)).toMatchObject({ ok: true, records: 1 });
  });
});
