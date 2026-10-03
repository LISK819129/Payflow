import { env } from "../config/env";
import { TokenProvider } from "./auth";
import { PayPalHttp } from "./http";

export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

function credentials() {
  const e = env();
  const missing = [
    !e.PAYPAL_CLIENT_ID && "PAYPAL_CLIENT_ID",
    !e.PAYPAL_CLIENT_SECRET && "PAYPAL_CLIENT_SECRET",
  ].filter(Boolean) as string[];
  if (missing.length) return { missing };
  return { clientId: e.PAYPAL_CLIENT_ID!, clientSecret: e.PAYPAL_CLIENT_SECRET!, baseUrl: PAYPAL_SANDBOX_BASE };
}

const g = globalThis as unknown as { __paypalTokens?: TokenProvider; __paypalHttp?: PayPalHttp };

export function paypalTokens(): TokenProvider {
  g.__paypalTokens ??= new TokenProvider(credentials);
  return g.__paypalTokens;
}

/** Process-wide PayPal REST client (Sandbox only; see env()). */
export function paypal(): PayPalHttp {
  g.__paypalHttp ??= new PayPalHttp(() => PAYPAL_SANDBOX_BASE, paypalTokens());
  return g.__paypalHttp;
}
