import { createSign } from "node:crypto";
import { generate } from "selfsigned";
import { signedMessage, type WebhookHeaders } from "@/server/paypal/webhook-verify";

/** A certificate shaped like PayPal's message-verification cert, but ours. */
export async function makePayPalLikeCert(commonName = "messageverificationcerts.paypal.com") {
  const pems = await generate([{ name: "commonName", value: commonName }], { keySize: 2048, algorithm: "sha256" });
  return { certPem: pems.cert, privateKeyPem: pems.private };
}

export const TEST_CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test";

export function signWebhook(
  rawBody: string,
  webhookId: string,
  privateKeyPem: string,
  overrides: Partial<WebhookHeaders> = {},
): WebhookHeaders {
  const base: WebhookHeaders = {
    transmissionId: overrides.transmissionId ?? `tx-${Math.random().toString(36).slice(2)}`,
    transmissionTime: overrides.transmissionTime ?? new Date().toISOString(),
    transmissionSig: "",
    certUrl: overrides.certUrl ?? TEST_CERT_URL,
    authAlgo: overrides.authAlgo ?? "SHA256withRSA",
  };
  const signer = createSign("RSA-SHA256");
  signer.update(signedMessage(base, webhookId, rawBody));
  signer.end();
  return { ...base, transmissionSig: overrides.transmissionSig ?? signer.sign(privateKeyPem, "base64") };
}

export function headerGetter(h: WebhookHeaders) {
  const map: Record<string, string> = {
    "paypal-transmission-id": h.transmissionId,
    "paypal-transmission-time": h.transmissionTime,
    "paypal-transmission-sig": h.transmissionSig,
    "paypal-cert-url": h.certUrl,
    "paypal-auth-algo": h.authAlgo,
  };
  return (name: string) => map[name.toLowerCase()] ?? null;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function captureEvent(id = `WH-${Math.random().toString(36).slice(2)}`) {
  return {
    id,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "capture",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    summary: "Payment completed for $ 4000.0 USD",
    resource: { id: "CAP-123", status: "COMPLETED", amount: { currency_code: "USD", value: "4000.00" } },
  };
}
