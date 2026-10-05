import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { clientIp } from "../security/client-ip";
import { rateLimit } from "../security/rate-limit";
import { runtimeDeps } from "../workflow/runtime/deps";
import type { RuntimeDeps } from "../workflow/runtime/types";
import { buildMcpServer } from "./mcp";
import { authenticateAgent } from "./service";

/** MCP calls are small; evidence text is capped at 8 KB per document by the schema. */
export const MAX_BODY_BYTES = 64 * 1024;
const CALLS_PER_MINUTE = 120;
const UNAUTHENTICATED_PER_MINUTE = 30;

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * POST /api/mcp — MCP Streamable HTTP, stateless, JSON responses.
 *
 * Order: size limit → per-IP limit for failed authentication → bearer
 * authentication (status/expiry re-read every call) → per-agent limit → a
 * fresh MCP server bound to that agent. Error bodies never echo the
 * credential or any part of it.
 */
export async function handleMcpRequest(request: Request, deps: RuntimeDeps = runtimeDeps): Promise<Response> {
  if (request.method !== "POST") return rpcError(405, -32000, "Method not allowed: this server is stateless; use POST", { allow: "POST" });
  const ip = clientIp((n) => request.headers.get(n));

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return rpcError(413, -32600, "Request too large");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return rpcError(413, -32600, "Request too large");

  const auth = await authenticateAgent(request.headers.get("authorization"));
  if (!auth.ok) {
    if (!rateLimit(`mcp-unauth:${ip}`, UNAUTHENTICATED_PER_MINUTE, 60_000).ok) return rpcError(429, -32000, "Too many failed attempts");
    const status = auth.code === "AGENT_REVOKED" || auth.code === "AGENT_EXPIRED" ? 403 : 401;
    return rpcError(status, -32001, `${auth.code}: ${auth.message}`, {
      "www-authenticate": `Bearer realm="payflow-agents", error="${status === 401 ? "invalid_token" : "insufficient_scope"}", error_description="${auth.code}"`,
    });
  }
  const limited = rateLimit(`mcp:${auth.agent.id}`, CALLS_PER_MINUTE, 60_000);
  if (!limited.ok) return rpcError(429, -32000, "Rate limited", { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Parse error");
  }

  const server = buildMcpServer({ agent: auth.agent }, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody: body });
  } catch (e) {
    console.error("[mcp] request failed:", (e as Error).message);
    return rpcError(500, -32603, "Internal error");
  } finally {
    // JSON mode: the response is complete; release the per-call server.
    void server.close().catch(() => {});
  }
}
