/** Liveness: the web process answers. No dependencies are touched, nothing about the configuration is returned. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
