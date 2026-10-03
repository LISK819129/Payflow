/**
 * Development tool: sends a small genuine PayPal Sandbox payout, which makes
 * PayPal emit real PAYMENT.PAYOUTSBATCH.* / PAYMENT.PAYOUTS-ITEM.* webhooks.
 * Sandbox only — env() refuses to run against live.
 *
 *   pnpm paypal:sandbox:payout 1.00 receiver@example.com "note"
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { paypal } from "../src/server/paypal/client";
import { PayPalApiError } from "../src/server/paypal/errors";

type PayoutBatch = {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header: { sender_batch_id: string } };
  items?: { payout_item_id: string; transaction_status?: string }[];
};

async function main() {
  const amount = process.argv[2] ?? "1.00";
  const receiver = process.argv[3] ?? "payflow-validation@example.com";
  const note = process.argv[4] ?? "PayFlow Sandbox validation payout";
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("amount must look like 1.00");

  const senderBatchId = `pf-${randomUUID()}`;
  const res = await paypal().request<PayoutBatch>({
    method: "POST",
    path: "/v1/payments/payouts",
    requestId: senderBatchId,
    body: {
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "PayFlow sandbox payout", email_message: note },
      items: [
        {
          recipient_type: "EMAIL",
          receiver,
          amount: { value: amount, currency: "USD" },
          note,
          sender_item_id: `${senderBatchId}-1`,
        },
      ],
    },
  });
  const h = res.data.batch_header;
  console.log(`Payout batch ${h.payout_batch_id} → ${h.batch_status}  sender_batch_id=${h.sender_batch_header.sender_batch_id}  debug_id=${res.debugId}`);

  // Poll briefly so the batch id and its final item status are visible here too.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await paypal().request<PayoutBatch>({ method: "GET", path: `/v1/payments/payouts/${h.payout_batch_id}` });
    const item = s.data.items?.[0];
    console.log(`  status ${s.data.batch_header.batch_status}  item ${item?.payout_item_id ?? "?"} ${item?.transaction_status ?? ""}`);
    if (!["PENDING", "PROCESSING"].includes(s.data.batch_header.batch_status)) break;
  }
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error("PayPal error:", JSON.stringify(err.toJSON(), null, 2));
  else console.error(err);
  process.exit(1);
});
