import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "@/server/audit/audit";
import { resetEnvCache } from "@/server/config/env";
import { closeDb, db } from "@/server/db/client";
import { auditRecords, paypalEvents } from "@/server/db/schema";
import { QUEUES, boss, ensureQueues, stopBoss } from "@/server/jobs/boss";
import { ingestPayPalWebhook } from "@/server/webhooks/ingest";
import { resetWorkspaceCache } from "@/server/workspace";
import { createWorkspace, resetTestDb } from "./support/db";
import { captureEvent, headerGetter, makePayPalLikeCert, signWebhook } from "./support/paypal-fakes";

const WEBHOOK_ID = "WH-TEST-INGEST";
let cert: { certPem: string; privateKeyPem: string };
const deps = () => ({ fetchCert: async () => cert.certPem });

beforeAll(async () => {
  process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;
  process.env.PAYPAL_ALLOW_SIMULATOR_EVENTS = "false";
  resetEnvCache();
  cert = await makePayPalLikeCert();
  await resetTestDb();
  await ensureQueues(await boss("migrate"));
});

afterAll(async () => {
  await stopBoss();
  await closeDb();
});

beforeEach(async () => {
  await resetTestDb();
  await db().execute(sql`delete from pgboss.job`);
  resetWorkspaceCache();
});

async function deliver(event: object, webhookId = WEBHOOK_ID) {
  const raw = JSON.stringify(event);
  const headers = signWebhook(raw, webhookId, cert.privateKeyPem);
  return ingestPayPalWebhook(raw, headerGetter(headers), deps());
}

describe("webhook ingest", () => {
  it("stores a verified event once and enqueues it in the same transaction", async () => {
    const ws = await createWorkspace("PixelForge");
    const event = captureEvent();
    expect(await deliver(event)).toMatchObject({ status: 200, outcome: "accepted", eventId: event.id });

    const [row] = await db().select().from(paypalEvents).where(eq(paypalEvents.eventId, event.id));
    expect(row).toMatchObject({
      workspaceId: ws.id,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: "CAP-123",
      verification: "SELF",
      provenance: "REAL_PAYPAL_SANDBOX",
      deliveries: 1,
    });
    // The exact signed bytes and headers are kept so the signature can be re-verified later.
    expect(row.rawBody).toBe(JSON.stringify(event));
    expect(row.signature).toMatchObject({ authAlgo: "SHA256withRSA" });
    const jobs = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.paypalEventRoute} and data->>'paypalEventId' = ${row.id}`,
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it("treats a redelivery (new transmission, same event id) as a duplicate: no second job", async () => {
    await createWorkspace("PixelForge");
    const event = captureEvent();
    await deliver(event);
    expect(await deliver(event)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(await deliver(event)).toMatchObject({ status: 200, outcome: "duplicate" });

    const rows = await db().select().from(paypalEvents).where(eq(paypalEvents.eventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveries).toBe(3);
    const jobs = await db().execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.paypalEventRoute}`);
    expect(jobs.rows[0].n).toBe(1);
  });

  it("handles concurrent duplicate deliveries without double-processing", async () => {
    await createWorkspace("PixelForge");
    const event = captureEvent();
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(event)));
    expect(results.filter((r) => r.status === 200 && r.outcome === "accepted")).toHaveLength(1);
    const jobs = await db().execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.paypalEventRoute}`);
    expect(jobs.rows[0].n).toBe(1);
  });

  it("rejects a forged event without storing anything", async () => {
    await createWorkspace("PixelForge");
    const r = await deliver(captureEvent(), "WH-NOT-OURS");
    expect(r.status).toBe(400);
    expect(await db().select().from(paypalEvents)).toHaveLength(0);
  });

  it("writes received and duplicate records to a verifiable audit chain", async () => {
    const ws = await createWorkspace("PixelForge");
    const event = captureEvent();
    await deliver(event);
    await deliver(event);
    const kinds = (await db().select().from(auditRecords).where(eq(auditRecords.workspaceId, ws.id))).map((r) => r.kind).sort();
    expect(kinds).toEqual(["paypal.webhook.duplicate", "paypal.webhook.received"]);
    expect(await verifyChain(ws.id)).toMatchObject({ ok: true, records: 2 });
  });
});
