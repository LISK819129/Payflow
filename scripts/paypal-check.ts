/**
 * Verifies the PayPal Sandbox connection end to end:
 *   1. OAuth client-credentials token (and which features the app's scopes grant)
 *   2. Real read calls: invoices list, registered webhooks
 * Records the result in the audit chain. Prints no secrets.
 *
 *   pnpm paypal:check
 */
import "./load-env";
import { audit } from "../src/server/audit/audit";
import { integrationStatus } from "../src/server/config/env";
import { closeDb } from "../src/server/db/client";
import { paypal, paypalTokens } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";
import { merchantWorkspaceId } from "../src/server/workspace";

const FEATURES: [string, RegExp][] = [
  ["Invoicing", /services\/invoicing/],
  ["Payouts", /payouts/],
  ["Transaction Search", /reporting\/search\/read/],
  ["Disputes", /disputes/],
  ["Subscriptions", /billing|subscriptions/],
  ["Webhooks", /applications\/webhooks/],
  ["Payments / Orders", /payments\/payment|checkout/],
];

async function main() {
  const status = integrationStatus().paypal;
  if (!status.configured) {
    console.error(`PayPal setup required: missing ${status.missing.join(", ")} in .env.local`);
    process.exit(2);
  }

  const token = await paypalTokens().get();
  const minutes = Math.round((token.expiresAt - Date.now()) / 60_000);
  console.log(`OAuth OK  app_id=${token.appId ?? "?"}  expires in ~${minutes} min  scopes=${token.scopes.length}`);
  const features = Object.fromEntries(FEATURES.map(([name, re]) => [name, token.scopes.some((s) => re.test(s))]));
  for (const [name, ok] of Object.entries(features)) console.log(`  ${ok ? "✓" : "✗"} ${name}`);

  const invoices = await paypal().request<{ total_items?: number; items?: unknown[] }>({
    method: "GET",
    path: "/v2/invoicing/invoices",
    query: { page: 1, page_size: 1, total_required: true },
  });
  console.log(`Invoices API OK  total_items=${invoices.data.total_items ?? 0}  debug_id=${invoices.debugId}`);

  const hooks = await paypal().request<{ webhooks: { id: string; url: string; event_types: { name: string }[] }[] }>({
    method: "GET",
    path: "/v1/notifications/webhooks",
  });
  console.log(`Webhooks API OK  registered=${hooks.data.webhooks.length}`);
  for (const w of hooks.data.webhooks) console.log(`  ${w.id}  ${w.url}  (${w.event_types.length} event types)`);

  await audit({
    workspaceId: await merchantWorkspaceId(),
    actor: "system",
    kind: "paypal.connection.verified",
    summary: `PayPal Sandbox connection verified (app ${token.appId ?? "?"})`,
    payload: { appId: token.appId, features, webhooks: hooks.data.webhooks.map((w) => ({ id: w.id, url: w.url })) },
  });
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
    else console.error(err);
    await closeDb();
    process.exit(1);
  });
