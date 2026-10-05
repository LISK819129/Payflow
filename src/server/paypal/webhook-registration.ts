import { randomUUID } from "node:crypto";
import { PayPalApiError } from "./errors";
import type { PayPalRequest, PayPalResponse } from "./http";

/**
 * Points PayFlow's single webhook at a URL. PayFlow owns one webhook per
 * PayPal app: an existing one is moved (PATCH), never duplicated; any other
 * PayFlow webhooks (old tunnels) are removed so PayPal stops retrying into
 * dead hosts. A new webhook is created only if none exists.
 */
export const WEBHOOK_EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.REFUNDED",
  "INVOICING.INVOICE.UPDATED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "CATALOG.PRODUCT.CREATED",
  "BILLING.PLAN.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
];

type Webhook = { id: string; url: string; event_types: { name: string }[] };
type Http = { request<T>(req: PayPalRequest): Promise<PayPalResponse<T>> };

export const WEBHOOK_PATH = "/api/webhooks/paypal";

export type Registration = { action: "updated" | "unchanged" | "created"; id: string; url: string; removed: string[] };

export type WebhookPlan = {
  /** What registerWebhook would do: move an existing webhook, nothing, or create the first one. */
  action: "move" | "already_here" | "create";
  url: string;
  existing: { id: string; url: string } | null;
  /** Other PayFlow webhooks (old tunnels) that would be removed. */
  remove: { id: string; url: string }[];
};

/** Read-only: what `registerWebhook` would do for this host (one GET to PayPal). */
export async function planWebhook(http: Http, host: string): Promise<WebhookPlan> {
  if (!/^https:\/\//.test(host)) throw new Error("The webhook host must be an https:// URL");
  const url = new URL(WEBHOOK_PATH, host).toString();
  const { data } = await http.request<{ webhooks: Webhook[] }>({ method: "GET", path: "/v1/notifications/webhooks" });
  const ours = data.webhooks.filter((w) => {
    try {
      return new URL(w.url).pathname === WEBHOOK_PATH;
    } catch {
      return false;
    }
  });
  const existing = ours.find((w) => w.url === url) ?? ours[0] ?? null;
  return {
    action: !existing ? "create" : existing.url === url ? "already_here" : "move",
    url,
    existing: existing ? { id: existing.id, url: existing.url } : null,
    remove: ours.filter((w) => w.id !== existing?.id).map((w) => ({ id: w.id, url: w.url })),
  };
}

export async function registerWebhook(http: Http, host: string): Promise<Registration> {
  if (!/^https:\/\//.test(host)) throw new Error("The webhook host must be an https:// URL");
  const url = new URL(WEBHOOK_PATH, host).toString();
  const eventTypes = WEBHOOK_EVENT_TYPES.map((name) => ({ name }));
  const { data } = await http.request<{ webhooks: Webhook[] }>({ method: "GET", path: "/v1/notifications/webhooks" });
  const ours = data.webhooks.filter((w) => {
    try {
      return new URL(w.url).pathname === WEBHOOK_PATH;
    } catch {
      return false;
    }
  });
  const existing = ours.find((w) => w.url === url) ?? ours[0];
  if (!existing) {
    const created = await http.request<Webhook>({ method: "POST", path: "/v1/notifications/webhooks", requestId: randomUUID(), body: { url, event_types: eventTypes } });
    return { action: "created", id: created.data.id, url, removed: [] };
  }
  let action: Registration["action"] = "updated";
  try {
    await http.request({
      method: "PATCH",
      path: `/v1/notifications/webhooks/${existing.id}`,
      body: [
        { op: "replace", path: "/url", value: url },
        { op: "replace", path: "/event_types", value: eventTypes },
      ],
    });
  } catch (err) {
    // Already pointing at this URL with these event types.
    if (!(err instanceof PayPalApiError && err.code === "WEBHOOK_PATCH_REQUEST_NO_CHANGE")) throw err;
    action = "unchanged";
  }
  const removed: string[] = [];
  for (const stale of ours.filter((w) => w.id !== existing.id)) {
    await http.request({ method: "DELETE", path: `/v1/notifications/webhooks/${stale.id}` });
    removed.push(stale.id);
  }
  return { action, id: existing.id, url, removed };
}
