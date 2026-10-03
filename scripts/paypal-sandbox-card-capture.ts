/**
 * Development tool: produces a genuine PayPal Sandbox capture (and therefore a
 * real PAYMENT.CAPTURE.COMPLETED webhook) without a browser buyer, by paying a
 * server-created order with one of PayPal's published sandbox test cards.
 * Sandbox only — env() refuses to run against live.
 *
 *   pnpm paypal:sandbox:capture 12.00 "Phase 2 webhook validation"
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";

// PayPal-published sandbox test card (developer.paypal.com test cards / AI Toolkit test-accounts). Not a real card.
const SANDBOX_TEST_VISA = "4012000033330026";

type Order = {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] } }[];
};

async function main() {
  const amount = process.argv[2] ?? "12.00";
  const description = process.argv[3] ?? "PayFlow Sandbox validation";
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("amount must look like 12.00");

  const key = randomUUID();
  const created = await paypal().request<Order>({
    method: "POST",
    path: "/v2/checkout/orders",
    requestId: `order-${key}`,
    preferRepresentation: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: `pf-${key.slice(0, 8)}`, description, amount: { currency_code: "USD", value: amount } }],
      payment_source: {
        card: {
          number: SANDBOX_TEST_VISA,
          expiry: "2030-12",
          name: "Nova Labs Test",
          billing_address: { address_line_1: "1 Market St", admin_area_2: "San Francisco", admin_area_1: "CA", postal_code: "94105", country_code: "US" },
        },
      },
    },
  });
  console.log(`Order ${created.data.id} → ${created.data.status}  (debug_id ${created.debugId})`);

  let order = created.data;
  if (order.status === "APPROVED") {
    const captured = await paypal().request<Order>({
      method: "POST",
      path: `/v2/checkout/orders/${order.id}/capture`,
      requestId: `capture-${key}`,
      preferRepresentation: true,
      body: {},
    });
    order = captured.data;
    console.log(`Captured → ${order.status}  (debug_id ${captured.debugId})`);
  }

  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`No capture on order ${order.id} (status ${order.status})`);
  console.log(`Capture ${capture.id} ${capture.status} ${capture.amount.value} ${capture.amount.currency_code}`);
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
  else console.error(err);
  process.exit(1);
});
