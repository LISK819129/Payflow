import { PayPalApiError, PayPalNotConfiguredError } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PayPalCredentials = { clientId: string; clientSecret: string; baseUrl: string };

export type AccessToken = {
  token: string;
  expiresAt: number;
  scopes: string[];
  appId?: string;
};

/** Refresh this long before PayPal's stated expiry so an in-flight call never carries a dead token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * OAuth client-credentials token cache. One token per credential set, refreshed
 * proactively from `expires_in` (never assumed), with concurrent callers sharing
 * a single in-flight request.
 */
export class TokenProvider {
  private current?: AccessToken;
  private inflight?: Promise<AccessToken>;

  constructor(
    private readonly creds: () => PayPalCredentials | { missing: string[] },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<AccessToken> {
    if (this.current && this.current.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.current;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Called after a 401: the cached token is no good regardless of its expiry. */
  invalidate(token?: string) {
    if (!token || this.current?.token === token) this.current = undefined;
  }

  private async fetchToken(): Promise<AccessToken> {
    const c = this.creds();
    if ("missing" in c) throw new PayPalNotConfiguredError(c.missing);

    let res: Response;
    try {
      res = await this.fetchImpl(`${c.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new PayPalApiError(0, "NETWORK", `PayPal OAuth request failed: ${(err as Error).message}`);
    }

    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      // OAuth errors use {error, error_description}, not the REST error shape.
      const code = typeof body?.error === "string" ? body.error : "OAUTH_FAILED";
      const desc = typeof body?.error_description === "string" ? body.error_description : `HTTP ${res.status}`;
      throw new PayPalApiError(res.status, code, `PayPal OAuth failed: ${desc}`, debugId);
    }
    if (!body || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new PayPalApiError(res.status, "MALFORMED_RESPONSE", "PayPal OAuth response missing access_token/expires_in", debugId);
    }

    this.current = {
      token: body.access_token,
      expiresAt: this.now() + body.expires_in * 1000,
      scopes: typeof body.scope === "string" ? body.scope.split(" ") : [],
      appId: typeof body.app_id === "string" ? body.app_id : undefined,
    };
    return this.current;
  }
}
