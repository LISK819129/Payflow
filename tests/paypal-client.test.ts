import { describe, expect, it, vi } from "vitest";
import { TokenProvider, type FetchLike } from "@/server/paypal/auth";
import { PayPalApiError } from "@/server/paypal/errors";
import { PayPalHttp } from "@/server/paypal/http";
import { jsonResponse } from "./support/paypal-fakes";

const BASE = "https://api-m.sandbox.paypal.com";
const creds = () => ({ clientId: "id", clientSecret: "secret", baseUrl: BASE });

function tokenFetch(expiresIn = 32400) {
  let n = 0;
  const fn = vi.fn<FetchLike>(async () => {
    n += 1;
    return jsonResponse(200, { access_token: `tok-${n}`, expires_in: expiresIn, scope: "a b", app_id: "APP-1" });
  });
  return fn;
}

describe("TokenProvider", () => {
  it("caches the token until shortly before expires_in", async () => {
    let now = 0;
    const f = tokenFetch(3600);
    const p = new TokenProvider(creds, f, () => now);
    expect((await p.get()).token).toBe("tok-1");
    now = 50 * 60_000; // 50 min: still outside the 5 min refresh margin
    expect((await p.get()).token).toBe("tok-1");
    now = 56 * 60_000; // inside the margin → refresh
    expect((await p.get()).token).toBe("tok-2");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const f = tokenFetch();
    const p = new TokenProvider(creds, f);
    const tokens = await Promise.all(Array.from({ length: 10 }, () => p.get()));
    expect(new Set(tokens.map((t) => t.token))).toEqual(new Set(["tok-1"]));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("sends client credentials as HTTP Basic", async () => {
    const f = tokenFetch();
    await new TokenProvider(creds, f).get();
    const init = f.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(init.body).toBe("grant_type=client_credentials");
  });

  it("reports missing credentials without calling PayPal", async () => {
    const f = tokenFetch();
    const p = new TokenProvider(() => ({ missing: ["PAYPAL_CLIENT_ID"] }), f);
    await expect(p.get()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(f).not.toHaveBeenCalled();
  });

  it("surfaces OAuth errors and malformed responses", async () => {
    const bad = new TokenProvider(creds, async () =>
      jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }, { "paypal-debug-id": "dbg1" }),
    );
    await expect(bad.get()).rejects.toMatchObject({ status: 401, code: "invalid_client", debugId: "dbg1" });
    const malformed = new TokenProvider(creds, async () => jsonResponse(200, { token_type: "Bearer" }));
    await expect(malformed.get()).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});

function client(api: FetchLike, maxAttempts = 4) {
  const tokens = new TokenProvider(creds, tokenFetch());
  return new PayPalHttp(() => BASE, tokens, api, { maxAttempts, baseDelayMs: 1 }, async () => {});
}

describe("PayPalHttp", () => {
  it("refuses a POST without an idempotency key", async () => {
    const api = vi.fn<FetchLike>();
    await expect(client(api).request({ method: "POST", path: "/v2/checkout/orders", body: {} })).rejects.toThrow(/requestId/);
    expect(api).not.toHaveBeenCalled();
  });

  it("retries 429 and 5xx with the same PayPal-Request-Id", async () => {
    const statuses = [429, 503, 201];
    const api = vi.fn<FetchLike>(async () => {
      const s = statuses.shift()!;
      return s === 201 ? jsonResponse(201, { id: "ORDER-1" }) : jsonResponse(s, { name: "RATE_LIMIT_REACHED" });
    });
    const res = await client(api).request<{ id: string }>({ method: "POST", path: "/v2/checkout/orders", body: {}, requestId: "run1:node3" });
    expect(res.data.id).toBe("ORDER-1");
    expect(api).toHaveBeenCalledTimes(3);
    const ids = api.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)["PayPal-Request-Id"]);
    expect(ids).toEqual(["run1:node3", "run1:node3", "run1:node3"]);
  });

  it("refreshes the token once on 401", async () => {
    const auths: string[] = [];
    const api = vi.fn<FetchLike>(async (_u, init) => {
      auths.push((init!.headers as Record<string, string>).Authorization);
      return auths.length === 1 ? jsonResponse(401, { name: "AUTHENTICATION_FAILURE" }) : jsonResponse(200, { ok: true });
    });
    await client(api).request({ method: "GET", path: "/v1/x" });
    expect(auths).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("does not loop on repeated 401s", async () => {
    const api = vi.fn<FetchLike>(async () => jsonResponse(401, { name: "AUTHENTICATION_FAILURE", message: "nope" }));
    await expect(client(api).request({ method: "GET", path: "/v1/x" })).rejects.toMatchObject({ status: 401 });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("maps PayPal error bodies including debug_id, and does not retry 4xx", async () => {
    const api = vi.fn<FetchLike>(async () =>
      jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed", debug_id: "abc123", details: [{ issue: "INSTRUMENT_DECLINED" }] }),
    );
    const err = await client(api).request({ method: "POST", path: "/v2/x", body: {}, requestId: "r" }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ status: 422, code: "UNPROCESSABLE_ENTITY", debugId: "abc123" });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("treats a non-JSON body as a malformed response, not a success", async () => {
    const api = vi.fn<FetchLike>(async () => new Response("<html>gateway</html>", { status: 200 }));
    await expect(client(api).request({ method: "GET", path: "/v1/x" })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("gives up after the retry limit when PayPal is unavailable", async () => {
    const api = vi.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client(api, 3).request({ method: "GET", path: "/v1/x" })).rejects.toMatchObject({ code: "NETWORK" });
    expect(api).toHaveBeenCalledTimes(3);
  });
});
