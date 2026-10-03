import { PayPalApiError } from "./errors";
import type { FetchLike, TokenProvider } from "./auth";

export type PayPalRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Required on every POST. Derive it from the business operation (run + node),
   * not from the attempt, so a retry after a crash is recognised by PayPal as the
   * same request and never executed twice.
   */
  requestId?: string;
  /** Ask PayPal to return the full resource instead of a minimal one. */
  preferRepresentation?: boolean;
};

export type PayPalResponse<T> = { status: number; data: T; debugId?: string };

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number };

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 400 };

/**
 * Thin REST client: auth header, idempotency header, typed errors with debug id,
 * bounded exponential backoff on 429/5xx/network errors, one forced token refresh
 * on 401. Retrying a POST is only safe because `requestId` is mandatory.
 */
export class PayPalHttp {
  constructor(
    private readonly baseUrl: () => string,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async request<T>(req: PayPalRequest): Promise<PayPalResponse<T>> {
    if (req.method === "POST" && !req.requestId) {
      throw new Error(`PayPal POST ${req.path} requires a requestId (PayPal-Request-Id)`);
    }
    const url = new URL(req.path, this.baseUrl());
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    let refreshedAfter401 = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.tokens.get();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/json",
      };
      if (req.body !== undefined) headers["Content-Type"] = "application/json";
      if (req.requestId) headers["PayPal-Request-Id"] = req.requestId;
      if (req.preferRepresentation) headers["Prefer"] = "return=representation";

      let res: Response | undefined;
      let networkError: Error | undefined;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        networkError = err as Error;
      }

      if (res?.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.tokens.invalidate(token.token);
        continue;
      }

      const retryable = networkError !== undefined || res!.status === 429 || res!.status >= 500;
      if (retryable && attempt < this.retry.maxAttempts) {
        const retryAfter = Number(res?.headers.get("retry-after"));
        const backoff = this.retry.baseDelayMs * 2 ** (attempt - 1);
        const jitter = Math.random() * this.retry.baseDelayMs;
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff + jitter);
        continue;
      }

      if (networkError) {
        throw new PayPalApiError(0, "NETWORK", `PayPal ${req.method} ${req.path} failed: ${networkError.message}`);
      }
      return this.parse<T>(req, res!);
    }
  }

  private async parse<T>(req: PayPalRequest, res: Response): Promise<PayPalResponse<T>> {
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    const text = await res.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new PayPalApiError(res.status, "MALFORMED_RESPONSE", `PayPal ${req.method} ${req.path} returned non-JSON`, debugId);
      }
    }
    if (!res.ok) {
      const body = (json ?? {}) as { name?: string; message?: string; details?: unknown; debug_id?: string };
      throw new PayPalApiError(
        res.status,
        body.name ?? `HTTP_${res.status}`,
        body.message ?? `PayPal ${req.method} ${req.path} failed with HTTP ${res.status}`,
        body.debug_id ?? debugId,
        body.details,
      );
    }
    return { status: res.status, data: json as T, debugId };
  }
}
