import { paypal, paypalTokens } from "./client";
import { PayPalApiError } from "./errors";

/** What each PayFlow feature needs from the sandbox app's OAuth scopes. */
export const PAYPAL_FEATURES = [
  { key: "orders", name: "Orders & payments", scope: /services\/payments\/payment\/authcapture|checkout\/payment-resources/, usedFor: "Client payments, capture" },
  { key: "refunds", name: "Refunds", scope: /services\/payments\/refund/, usedFor: "Reject-anomaly path, Scenario F" },
  { key: "payouts", name: "Payouts", scope: /payments\/payouts/, usedFor: "Procurement agent pays suppliers" },
  { key: "invoicing", name: "Invoicing", scope: /services\/invoicing/, usedFor: "Nova Labs invoices, reminders" },
  { key: "disputes", name: "Disputes", scope: /services\/disputes\/read-seller/, usedFor: "Dispute trigger → freeze" },
  { key: "subscriptions", name: "Subscriptions", scope: /services\/subscriptions/, usedFor: "Subscription triggers" },
  { key: "transactionSearch", name: "Transaction search", scope: /reporting\/search\/read/, usedFor: "Historical context back-fill" },
  { key: "webhooks", name: "Webhooks", scope: /applications\/webhooks/, usedFor: "Every workflow trigger" },
] as const;

export type FeatureKey = (typeof PAYPAL_FEATURES)[number]["key"];

export type PayPalConnection =
  | { ok: false; error: ReturnType<PayPalApiError["toJSON"]> }
  | {
      ok: true;
      appId?: string;
      expiresAt: number;
      features: { key: FeatureKey; name: string; usedFor: string; granted: boolean }[];
      webhooks: { id: string; url: string; eventTypes: number }[];
    };

export async function describeConnection(): Promise<PayPalConnection> {
  try {
    const token = await paypalTokens().get();
    const features = PAYPAL_FEATURES.map((f) => ({
      key: f.key,
      name: f.name,
      usedFor: f.usedFor,
      granted: token.scopes.some((s) => f.scope.test(s)),
    }));
    const hooks = await paypal().request<{ webhooks: { id: string; url: string; event_types: unknown[] }[] }>({
      method: "GET",
      path: "/v1/notifications/webhooks",
    });
    return {
      ok: true,
      appId: token.appId,
      expiresAt: token.expiresAt,
      features,
      webhooks: hooks.data.webhooks.map((w) => ({ id: w.id, url: w.url, eventTypes: w.event_types.length })),
    };
  } catch (err) {
    const e = err instanceof PayPalApiError ? err : new PayPalApiError(0, "UNKNOWN", (err as Error).message);
    return { ok: false, error: e.toJSON() };
  }
}
