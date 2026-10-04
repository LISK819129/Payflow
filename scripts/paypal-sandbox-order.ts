/**
 * Development tool: creates a PayPal Sandbox checkout order that a buyer still
 * has to approve (status CREATED) and prints its approval link. Opening that
 * link and approving with a Sandbox personal account makes it APPROVED, ready
 * for the "Capture approved orders" workflow. Sandbox only.
 *
 *   pnpm paypal:sandbox:order 64.00 "PixelForge order 1043"
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";

async function main() {
  const amount = process.argv[2] ?? "64.00";
  const description = process.argv[3] ?? "PayFlow Sandbox order";
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("amount must look like 64.00");
  const key = randomUUID();
  const r = await paypal().request<{ id: string; status: string; links?: { rel: string; href: string }[] }>({
    method: "POST",
    path: "/v2/checkout/orders",
    requestId: `order-${key}`,
    preferRepresentation: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: `pf-${key.slice(0, 8)}`, description, amount: { currency_code: "USD", value: amount } }],
      payment_source: { paypal: { experience_context: { user_action: "CONTINUE", return_url: "http://localhost:3000/", cancel_url: "http://localhost:3000/" } } },
    },
  });
  const approve = r.data.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  console.log(`Order ${r.data.id} → ${r.data.status} ${amount} USD  (debug_id ${r.debugId})`);
  if (approve) console.log(`Buyer approval link (Sandbox): ${approve}`);
}

main().catch((e) => {
  console.error(e instanceof PayPalApiError ? e.toJSON() : e);
  process.exit(1);
});
