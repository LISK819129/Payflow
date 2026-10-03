import { X509Certificate, createVerify } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * PayPal webhook signature verification.
 *
 * Self-verification (PayPal's preferred method): the signed message is
 *   `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`
 * verified SHA256withRSA against the certificate at `paypal-cert-url`.
 * The CRC is computed over the raw bytes as received; the body is never
 * parsed and re-serialised first.
 *
 * Postback (`/v1/notifications/verify-webhook-signature`) is the fallback when
 * self-verification can't complete (e.g. cert fetch fails). PayPal's simulator
 * signs mock events with the literal webhook id "WEBHOOK_ID"; those are only
 * accepted when explicitly allowed, and are labelled SIMULATOR.
 */

export const SIMULATOR_WEBHOOK_ID = "WEBHOOK_ID";

export type WebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

export type VerifyMethod = "SELF" | "POSTBACK" | "SIMULATOR";

export type VerifyResult = { ok: true; method: VerifyMethod } | { ok: false; reason: string };

export type VerifyDeps = {
  fetchCert: (url: string) => Promise<string>;
  /** Returns true only when PayPal answers verification_status SUCCESS. */
  postback?: (input: { headers: WebhookHeaders; webhookId: string; event: unknown }) => Promise<boolean>;
  now?: () => Date;
};

export function readWebhookHeaders(get: (name: string) => string | null | undefined): WebhookHeaders | null {
  const h = {
    transmissionId: get("paypal-transmission-id"),
    transmissionTime: get("paypal-transmission-time"),
    transmissionSig: get("paypal-transmission-sig"),
    certUrl: get("paypal-cert-url"),
    authAlgo: get("paypal-auth-algo"),
  };
  if (Object.values(h).some((v) => !v)) return null;
  return h as WebhookHeaders;
}

/** The certificate must come over HTTPS from a PayPal host; anything else is an attacker-chosen key. */
export function isTrustedCertUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com")) && !u.port;
  } catch {
    return false;
  }
}

export function signedMessage(h: WebhookHeaders, webhookId: string, rawBody: string | Buffer): string {
  const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(bytes) >>> 0}`;
}

function verifySelf(h: WebhookHeaders, webhookId: string, rawBody: string | Buffer, certPem: string, now: Date): boolean {
  const cert = new X509Certificate(certPem);
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return false;
  // PayPal signs with the messageverificationcerts.paypal.com certificate.
  if (!/paypal\.com/i.test(cert.subject)) return false;
  if (h.authAlgo.toUpperCase() !== "SHA256WITHRSA") return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signedMessage(h, webhookId, rawBody));
  verifier.end();
  return verifier.verify(cert.publicKey, Buffer.from(h.transmissionSig, "base64"));
}

export async function verifyWebhook(
  input: { rawBody: string; headers: WebhookHeaders | null; webhookId: string | undefined; allowSimulator: boolean },
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const { rawBody, headers, webhookId, allowSimulator } = input;
  if (!headers) return { ok: false, reason: "missing PayPal transmission headers" };
  if (!isTrustedCertUrl(headers.certUrl)) return { ok: false, reason: "certificate URL is not a PayPal HTTPS host" };
  const now = deps.now?.() ?? new Date();

  let certPem: string | undefined;
  let certError: string | undefined;
  try {
    certPem = await deps.fetchCert(headers.certUrl);
  } catch (err) {
    certError = (err as Error).message;
  }

  if (certPem) {
    try {
      if (webhookId && verifySelf(headers, webhookId, rawBody, certPem, now)) return { ok: true, method: "SELF" };
      if (allowSimulator && verifySelf(headers, SIMULATOR_WEBHOOK_ID, rawBody, certPem, now)) {
        return { ok: true, method: "SIMULATOR" };
      }
    } catch (err) {
      certError = `certificate unusable: ${(err as Error).message}`;
    }
  }

  // Postback is authoritative but cannot verify simulator events.
  if (webhookId && deps.postback) {
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: "body is not JSON" };
    }
    try {
      if (await deps.postback({ headers, webhookId, event })) return { ok: true, method: "POSTBACK" };
    } catch (err) {
      return { ok: false, reason: `postback verification failed: ${(err as Error).message}` };
    }
  }

  if (!webhookId) return { ok: false, reason: "PAYPAL_WEBHOOK_ID is not configured" };
  return { ok: false, reason: certError ?? "signature does not match" };
}
