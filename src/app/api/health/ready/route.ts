import { readiness } from "@/server/health";

/** Readiness: can PayFlow serve requests? 200 when ready, 503 otherwise. States only — no secrets or connection details. */
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await readiness();
  return Response.json(r, { status: r.status === "ready" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
