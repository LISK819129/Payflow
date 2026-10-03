import { beforeAll, describe, expect, it, vi } from "vitest";
import { isTrustedCertUrl, verifyWebhook, SIMULATOR_WEBHOOK_ID } from "@/server/paypal/webhook-verify";
import { TEST_CERT_URL, captureEvent, makePayPalLikeCert, signWebhook } from "./support/paypal-fakes";

const WEBHOOK_ID = "WH-REAL-123";
let cert: { certPem: string; privateKeyPem: string };
let impostor: { certPem: string; privateKeyPem: string };

beforeAll(async () => {
  cert = await makePayPalLikeCert();
  impostor = await makePayPalLikeCert("attacker.example.com");
});

const deps = () => ({ fetchCert: vi.fn(async () => cert.certPem) });

describe("webhook signature verification", () => {
  it("accepts a correctly signed event (self-verification)", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, WEBHOOK_ID, cert.privateKeyPem);
    expect(await verifyWebhook({ rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false }, deps())).toEqual({
      ok: true,
      method: "SELF",
    });
  });

  it("rejects a body changed after signing", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, WEBHOOK_ID, cert.privateKeyPem);
    const tampered = raw.replace("4000.00", "40000.00");
    const r = await verifyWebhook({ rawBody: tampered, headers, webhookId: WEBHOOK_ID, allowSimulator: false }, deps());
    expect(r.ok).toBe(false);
  });

  it("rejects re-serialised JSON (signature covers raw bytes)", async () => {
    const raw = JSON.stringify(captureEvent(), null, 2);
    const headers = signWebhook(raw, WEBHOOK_ID, cert.privateKeyPem);
    const reserialised = JSON.stringify(JSON.parse(raw));
    const r = await verifyWebhook({ rawBody: reserialised, headers, webhookId: WEBHOOK_ID, allowSimulator: false }, deps());
    expect(r.ok).toBe(false);
  });

  it("rejects an event signed for a different webhook", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, "WH-SOMEONE-ELSE", cert.privateKeyPem);
    const r = await verifyWebhook({ rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false }, deps());
    expect(r.ok).toBe(false);
  });

  it("refuses certificate URLs outside PayPal before fetching anything", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, WEBHOOK_ID, cert.privateKeyPem, { certUrl: "https://evil.example.com/cert.pem" });
    const d = deps();
    const r = await verifyWebhook({ rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false }, d);
    expect(r).toMatchObject({ ok: false });
    expect(d.fetchCert).not.toHaveBeenCalled();
    expect(isTrustedCertUrl("http://api.paypal.com/cert")).toBe(false);
    expect(isTrustedCertUrl("https://api.paypal.com.evil.io/cert")).toBe(false);
    expect(isTrustedCertUrl("https://api.paypal.com:8443/cert")).toBe(false);
    expect(isTrustedCertUrl(TEST_CERT_URL)).toBe(true);
  });

  it("rejects a valid signature from a certificate that is not PayPal's", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, WEBHOOK_ID, impostor.privateKeyPem);
    const r = await verifyWebhook(
      { rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false },
      { fetchCert: async () => impostor.certPem },
    );
    expect(r.ok).toBe(false);
  });

  it("accepts simulator events only when explicitly allowed, and labels them", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, SIMULATOR_WEBHOOK_ID, cert.privateKeyPem);
    expect((await verifyWebhook({ rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false }, deps())).ok).toBe(false);
    expect(await verifyWebhook({ rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: true }, deps())).toEqual({
      ok: true,
      method: "SIMULATOR",
    });
  });

  it("falls back to PayPal postback when the certificate cannot be fetched", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, WEBHOOK_ID, cert.privateKeyPem);
    const postback = vi.fn(async () => true);
    const r = await verifyWebhook(
      { rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false },
      { fetchCert: async () => Promise.reject(new Error("timeout")), postback },
    );
    expect(r).toEqual({ ok: true, method: "POSTBACK" });
    expect(postback).toHaveBeenCalledOnce();
  });

  it("fails closed when the postback says no", async () => {
    const raw = JSON.stringify(captureEvent());
    const headers = signWebhook(raw, WEBHOOK_ID, cert.privateKeyPem);
    const r = await verifyWebhook(
      { rawBody: raw, headers, webhookId: WEBHOOK_ID, allowSimulator: false },
      { fetchCert: async () => Promise.reject(new Error("timeout")), postback: async () => false },
    );
    expect(r.ok).toBe(false);
  });

  it("rejects requests without PayPal headers", async () => {
    const r = await verifyWebhook({ rawBody: "{}", headers: null, webhookId: WEBHOOK_ID, allowSimulator: true }, deps());
    expect(r).toEqual({ ok: false, reason: "missing PayPal transmission headers" });
  });
});
