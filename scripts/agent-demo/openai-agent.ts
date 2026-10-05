/**
 * A real external AI agent: an OpenAI model (Responses API) given PayFlow's MCP
 * server as a remote tool. OpenAI's platform is the MCP client — it lists
 * PayFlow's tools and calls them over the public URL with the agent's bearer
 * credential. The agent holds no PayPal credentials and no PayFlow session.
 *
 *   pnpm agent:openai <task-file> <label>
 *
 * Env: PAYFLOW_PUBLIC_MCP_URL (the tunnel's https://…/api/mcp). The call is
 * checked against the AI budget/phase cap first and recorded in ai_usage
 * afterwards (purpose "phase9.external_agent"), like every model call PayFlow makes.
 * The redacted transcript goes to evidence/phase9/external-agent/<label>.json.
 */
import "../load-env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { estimateCost, costOf } from "../../src/server/ai/pricing";
import { assertWithinBudget, recordUsage } from "../../src/server/ai/usage";
import { closeDb } from "../../src/server/db/client";
import { merchantWorkspaceId } from "../../src/server/workspace";
import { readAgentToken, redact } from "./agent-token";

const MODEL = "gpt-5.4-mini";

const SYSTEM = `You are "Cloud Procurement Agent", an autonomous purchasing agent for PixelForge Studio.
You can only act through the PayFlow tools. Call payflow_list_capabilities first to find your workflow_id.
Always pass a stable request_id you are given. Put invoice text in evidence.invoice_text.
PayFlow decides; you only request. Report exactly the state PayFlow returns (state, reasons, reference).
Never claim a payment was made unless the state is COMPLETED.`;

async function main() {
  const [taskFile, label] = process.argv.slice(2);
  if (!taskFile || !label) throw new Error("usage: openai-agent <task-file> <label>");
  const url = process.env.PAYFLOW_PUBLIC_MCP_URL;
  if (!url?.startsWith("https://")) throw new Error("PAYFLOW_PUBLIC_MCP_URL must be the public https URL of /api/mcp");
  const task = readFileSync(taskFile, "utf8");
  const token = readAgentToken();

  const worst = estimateCost(MODEL, 30_000, 3_000);
  const guard = await assertWithinBudget(worst);
  if (!guard.ok) throw new Error(guard.message);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const started = Date.now();
  let response: OpenAI.Responses.Response | null = null;
  let error: string | null = null;
  try {
    response = await client.responses.create({
      model: MODEL,
      store: false,
      instructions: SYSTEM,
      input: task,
      max_output_tokens: 3_000,
      reasoning: { effort: "low" },
      tools: [
        {
          type: "mcp",
          server_label: "payflow",
          server_description: "PayFlow Agent Gateway: request payments that PayFlow's authority and people decide.",
          server_url: url,
          headers: { Authorization: `Bearer ${token}` },
          require_approval: "never",
        },
      ],
    });
  } catch (e) {
    error = (e as Error).message;
  }

  const usage = response?.usage;
  const u = { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, cacheWriteTokens: 0, cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0 };
  await recordUsage({ workspaceId: await merchantWorkspaceId(), provider: "openai", model: response?.model ?? MODEL, purpose: "phase9.external_agent", requestId: response?.id ?? null, usage: u, ok: !!response && !error, error });

  const items = (response?.output ?? []).map((o) => {
    const x = o as unknown as Record<string, unknown>;
    if (x.type === "mcp_list_tools") return { type: "mcp_list_tools", server: x.server_label, tools: (x.tools as { name: string }[]).map((t) => t.name), error: x.error ?? null };
    if (x.type === "mcp_call") {
      let out: unknown = x.output;
      try {
        out = JSON.parse(String(x.output));
      } catch {
        /* keep text */
      }
      return { type: "mcp_call", tool: x.name, arguments: JSON.parse(String(x.arguments ?? "{}")), output: out, error: x.error ?? null };
    }
    if (x.type === "message") return { type: "message", text: ((x.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("") };
    return { type: x.type };
  });
  const transcript = {
    label: "REAL external AI agent (OpenAI Responses API, remote MCP) → PayFlow MCP",
    model: response?.model ?? MODEL,
    mcp_client: "OpenAI platform (remote MCP tool)",
    payflow_endpoint: "<public tunnel>/api/mcp",
    credential: "agent bearer token (redacted); no PayPal or PayFlow-owner credentials given to the agent",
    task,
    items,
    usage: { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cost_usd: costOf(response?.model ?? MODEL, u) },
    duration_ms: Date.now() - started,
    error,
  };
  const out = redact(JSON.stringify(transcript, null, 2), token);
  const dir = path.resolve("evidence/phase9/external-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${label}.json`), out + "\n");
  console.log(out);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error((e as Error).message);
    await closeDb();
    process.exit(1);
  });
