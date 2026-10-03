/**
 * Verifies the PayPal Sandbox connection against the real API and records the
 * result in the audit chain. Each feature probe is independent, so a missing
 * permission is reported rather than aborting the check. Prints no secrets.
 *
 *   pnpm paypal:check
 */
import "./load-env";
import { audit } from "../src/server/audit/audit";
import { integrationStatus } from "../src/server/config/env";
import { closeDb } from "../src/server/db/client";
import { describeConnection } from "../src/server/paypal/capabilities";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";
import { merchantWorkspaceId } from "../src/server/workspace";

type Probe = { name: string; ok: boolean; detail: string };

async function probe(name: string, fn: () => Promise<string>): Promise<Probe> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    const e = err instanceof PayPalApiError ? err : null;
    return { name, ok: false, detail: e ? `${e.status} ${e.code} debug_id=${e.debugId ?? "?"}` : String(err) };
  }
}

async function main() {
  const status = integrationStatus().paypal;
  if (!status.configured) {
    console.error(`PayPal setup required: missing ${status.missing.join(", ")} in .env.local`);
    process.exit(2);
  }

  const conn = await describeConnection();
  if (!conn.ok) {
    console.error("PayPal connection failed:", JSON.stringify(conn.error, null, 2));
    process.exit(1);
  }
  console.log(`OAuth OK  app_id=${conn.appId}  token expires in ~${Math.round((conn.expiresAt - Date.now()) / 60_000)} min`);
  for (const f of conn.features) console.log(`  ${f.granted ? "✓" : "✗"} ${f.name.padEnd(20)} ${f.usedFor}`);

  const probes = await Promise.all([
    probe("GET /v1/notifications/webhooks", async () => `${conn.webhooks.length} registered`),
    probe("GET /v1/notifications/webhooks-event-types", async () => {
      const r = await paypal().request<{ event_types: unknown[] }>({ method: "GET", path: "/v1/notifications/webhooks-event-types" });
      return `${r.data.event_types.length} event types available, debug_id=${r.debugId}`;
    }),
    probe("GET /v1/customer/disputes", async () => {
      const r = await paypal().request<{ items?: unknown[] }>({ method: "GET", path: "/v1/customer/disputes", query: { page_size: 1 } });
      return `${r.data.items?.length ?? 0} dispute(s) on first page, debug_id=${r.debugId}`;
    }),
    probe("GET /v2/invoicing/invoices", async () => {
      const r = await paypal().request<{ total_items?: number }>({ method: "GET", path: "/v2/invoicing/invoices", query: { page_size: 1, total_required: true } });
      return `${r.data.total_items ?? 0} invoice(s), debug_id=${r.debugId}`;
    }),
  ]);
  console.log("\nReal API probes:");
  for (const p of probes) console.log(`  ${p.ok ? "✓" : "✗"} ${p.name.padEnd(42)} ${p.detail}`);

  await audit({
    workspaceId: await merchantWorkspaceId(),
    actor: "system",
    kind: "paypal.connection.verified",
    summary: `PayPal Sandbox connection verified (app ${conn.appId}); ${conn.features.filter((f) => f.granted).length}/${conn.features.length} features granted`,
    payload: { appId: conn.appId, features: conn.features, probes, webhooks: conn.webhooks },
  });
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
