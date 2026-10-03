import { rateLimit } from "@/server/security/rate-limit";
import { ingestPayPalWebhook } from "@/server/webhooks/ingest";

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`webhook:${ip}`, 600, 60_000).ok) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });

  // Raw text first: the signature covers these exact bytes.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });

  try {
    const result = await ingestPayPalWebhook(rawBody, (name) => request.headers.get(name));
    if (result.status === 400) {
      console.warn("[webhook] rejected:", result.reason);
      return Response.json({ error: "verification failed" }, { status: 400 });
    }
    return Response.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    // 5xx makes PayPal retry later, which is what we want if our DB is down.
    console.error("[webhook] ingest error:", (err as Error).message);
    return Response.json({ error: "temporarily unavailable" }, { status: 503 });
  }
}
