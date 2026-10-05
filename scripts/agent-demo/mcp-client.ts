/**
 * A plain MCP client (the official TypeScript SDK client) talking to PayFlow's
 * MCP server over HTTP — the same protocol any MCP-capable agent uses.
 *
 *   pnpm agent:mcp tools [label]
 *   pnpm agent:mcp call <tool> <args.json> [label]
 *
 * Env: PAYFLOW_MCP_URL (default http://localhost:3000/api/mcp). The agent
 * credential is read from .env.agent.local and never printed. With a label,
 * the redacted exchange is saved to evidence/<EVIDENCE_PHASE|phase9>/mcp/<label>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readAgentToken, redact } from "./agent-token";

const URL_ = process.env.PAYFLOW_MCP_URL ?? "http://localhost:3000/api/mcp";

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  const token = readAgentToken();
  const client = new Client({ name: "payflow-demo-mcp-client", version: "1.0.0" });
  const exchange: Record<string, unknown> = { client: "@modelcontextprotocol/sdk Client (Streamable HTTP)", server: URL_.replace(/\/\/[^/]+/, "//<payflow>"), at: new Date().toISOString() };
  const label: string | undefined = cmd === "tools" ? a : c;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    exchange.serverInfo = client.getServerVersion();
    exchange.instructions = client.getInstructions();
    if (cmd === "tools") {
      const t = await client.listTools();
      exchange.tools = t.tools.map((x) => ({ name: x.name, title: x.title, description: x.description, annotations: x.annotations, input: x.inputSchema }));
    } else if (cmd === "call") {
      const args = JSON.parse(readFileSync(b, "utf8"));
      exchange.request = { tool: a, arguments: args };
      const r = await client.callTool({ name: a, arguments: args });
      exchange.response = { isError: !!r.isError, structuredContent: r.structuredContent ?? null, text: (r.content as { text?: string }[])[0]?.text ?? null };
    } else throw new Error("usage: tools [label] | call <tool> <args.json> [label]");
  } catch (e) {
    exchange.error = (e as Error).message;
  } finally {
    await client.close().catch(() => {});
  }
  const out = redact(JSON.stringify(exchange, null, 2), token);
  console.log(out);
  if (label) {
    const dir = path.resolve("evidence", process.env.EVIDENCE_PHASE ?? "phase9", "mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${label}.json`), out + "\n");
  }
}

main();
