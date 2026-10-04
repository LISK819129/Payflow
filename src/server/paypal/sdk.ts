import { ApiError, Client, Environment, OrdersController, PaymentsController, TransactionSearchController } from "@paypal/paypal-server-sdk";
import { paypalTokens } from "./client";
import { PayPalApiError } from "./errors";

/**
 * The official APIMatic-generated PayPal Server SDK, for the APIs it covers
 * (Orders, Payments, Transaction Search). It borrows PayFlow's token cache, so
 * the whole app holds one PayPal token, and its errors are mapped to the same
 * PayPalApiError (with debug_id) as the REST client's.
 */
const g = globalThis as unknown as { __paypalSdk?: { orders: OrdersController; payments: PaymentsController; transactions: TransactionSearchController } };

export function paypalSdk() {
  if (!g.__paypalSdk) {
    const client = new Client({
      environment: Environment.Sandbox,
      timeout: 30_000,
      clientCredentialsAuthCredentials: {
        oAuthClientId: "payflow", // unused: tokens come from oAuthTokenProvider
        oAuthClientSecret: "payflow",
        oAuthTokenProvider: async () => {
          const t = await paypalTokens().get();
          return { accessToken: t.token, tokenType: "Bearer", expiry: BigInt(Math.floor(t.expiresAt / 1000)) };
        },
      },
    });
    g.__paypalSdk = { orders: new OrdersController(client), payments: new PaymentsController(client), transactions: new TransactionSearchController(client) };
  }
  return g.__paypalSdk;
}

/** Runs an SDK call and normalises its failures to PayPalApiError (status, name, debug_id). */
export async function sdkCall<T>(what: string, fn: () => Promise<{ result: T; statusCode: number; headers: Record<string, string> }>) {
  try {
    const r = await fn();
    return { data: r.result, status: r.statusCode, debugId: r.headers["paypal-debug-id"] };
  } catch (err) {
    if (err instanceof PayPalApiError) throw err;
    if (err instanceof ApiError) {
      const body = (err.result ?? {}) as { name?: string; message?: string; debug_id?: string; details?: unknown };
      throw new PayPalApiError(err.statusCode, body.name ?? `HTTP_${err.statusCode}`, body.message ?? `${what} failed with HTTP ${err.statusCode}`, body.debug_id ?? err.headers?.["paypal-debug-id"], body.details);
    }
    throw new PayPalApiError(0, "NETWORK", `${what} failed: ${(err as Error).message}`);
  }
}
