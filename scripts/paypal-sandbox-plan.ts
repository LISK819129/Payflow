/**
 * Development tool: creates a real Sandbox catalog product and a monthly billing
 * plan. PayPal emits CATALOG.PRODUCT.CREATED and BILLING.PLAN.CREATED webhooks —
 * genuine signed events with no money movement. The plan is reused later for
 * subscription-trigger workflows.
 *
 *   pnpm paypal:sandbox:plan
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";

async function main() {
  const key = randomUUID();
  const product = await paypal().request<{ id: string; name: string }>({
    method: "POST",
    path: "/v1/catalogs/products",
    requestId: `product-${key}`,
    preferRepresentation: true,
    body: {
      name: "PixelForge Studio Support Retainer",
      description: "Monthly engineering support retainer (PayFlow sandbox)",
      type: "SERVICE",
      category: "SOFTWARE",
    },
  });
  console.log(`Product ${product.data.id} created  debug_id=${product.debugId}`);

  const plan = await paypal().request<{ id: string; status: string }>({
    method: "POST",
    path: "/v1/billing/plans",
    requestId: `plan-${key}`,
    preferRepresentation: true,
    body: {
      product_id: product.data.id,
      name: "Support Retainer — Monthly",
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: "250.00", currency_code: "USD" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    },
  });
  console.log(`Plan ${plan.data.id} ${plan.data.status}  debug_id=${plan.debugId}`);
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
  else console.error(err);
  process.exit(1);
});
