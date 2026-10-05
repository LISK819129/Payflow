import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rateLimit } from "../security/rate-limit";
import { runtimeDeps } from "../workflow/runtime/deps";
import type { RuntimeDeps } from "../workflow/runtime/types";
import { PaymentInput, RefundInput, RequestIdSchema, TestInput, toEnvelope } from "./envelope";
import { authoritySummary, cancelAgentRequest, getAgentRequest, listCapabilities, submitAgentRequest, touchAgent, type AgentContext } from "./service";

/**
 * PayFlow's MCP server, one instance per authenticated call (stateless).
 *
 * The tool surface is deliberately small. There is no tool that approves,
 * edits authority or workflows, reveals secrets, or reaches PayPal: an agent
 * can ask, look, test and withdraw — PayFlow decides, PayPal settles.
 */
export const TOOL_NAMES = [
  "payflow_list_capabilities",
  "payflow_request_payment",
  "payflow_request_refund",
  "payflow_test_request",
  "payflow_get_request",
  "payflow_get_authority",
  "payflow_cancel_request",
] as const;

const SUBMITS_PER_MINUTE = 20;

type Json = Record<string, unknown>;
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data });
const err = (code: string, message: string, extra: Json = {}) => {
  const data = { error: { code, message }, ...extra };
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: true };
};

export function buildMcpServer(ctx: AgentContext, deps: RuntimeDeps = runtimeDeps) {
  const server = new McpServer(
    { name: "payflow-agent-gateway", title: "PayFlow Agent Gateway", version: "0.9.0" },
    {
      instructions:
        "PayFlow is a financial control layer. You may REQUEST payouts or refunds through the workflows you are scoped to, check their status, run TEST requests, and withdraw a request that is waiting for review. " +
        "A request is never authorization: PayFlow's authority, AI analysis and, when required, a person decide, and only then does PayPal settle. " +
        "REQUEST accepted ≠ submitted to PayPal ≠ settled — poll payflow_get_request until state is terminal. You cannot approve requests or change limits; amounts over the limits go to a person. " +
        "Always reuse the same request_id when retrying the same request.",
    },
  );

  const tracked =
    <A,>(tool: string, fn: (args: A) => Promise<ReturnType<typeof ok>>) =>
    async (args: A) => {
      await touchAgent(ctx.agent.id, tool);
      return fn(args);
    };

  server.registerTool(
    "payflow_list_capabilities",
    {
      title: "What this agent may ask for",
      description: "Returns this agent's identity, the workflows and actions it may REQUEST (not authorize), what it can never do, and the request states. Call this first.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tracked("payflow_list_capabilities", async () => ok(await listCapabilities(ctx))),
  );

  const submit = (mode: "LIVE" | "TEST", action: "paypal.payout" | "paypal.refund", input: Parameters<typeof toEnvelope>[2] & { request_id: string }) => {
    const limit = rateLimit(`agent-submit:${ctx.agent.id}`, SUBMITS_PER_MINUTE, 60_000);
    if (!limit.ok) return Promise.resolve(err("RATE_LIMITED", `Too many requests; retry after ${Math.ceil(limit.retryAfterMs / 1000)}s with the same request_id`));
    return submitAgentRequest(ctx, input.request_id, toEnvelope(mode, action, input), deps).then((r) =>
      r.ok ? ok({ accepted: true, replayed: r.replayed, ...r.status, note: mode === "TEST" ? "TEST: evaluated in isolation; no money can move." : "Accepted for evaluation. This is not a payment; poll payflow_get_request." }) : err(r.code, r.message),
    );
  };

  server.registerTool(
    "payflow_request_payment",
    {
      title: "Request a payout (LIVE)",
      description:
        "Asks PayFlow to pay a supplier through one of your workflows. PayFlow checks identity, scope, authority (amount, recipient, currency, budget, frequency), analyses the purpose and evidence, and asks a person when required. " +
        "Returns the request state — ACCEPTED, PROCESSING, REVIEW_REQUIRED, DENIED, SUBMITTED_TO_PAYPAL, AWAITING_RECIPIENT, COMPLETED… SUBMITTED_TO_PAYPAL means PayPal accepted it, not that money arrived; only COMPLETED means PayPal confirmed settlement.",
      inputSchema: PaymentInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tracked("payflow_request_payment", async (a: z.infer<typeof PaymentInput>) => submit("LIVE", "paypal.payout", a)),
  );

  server.registerTool(
    "payflow_request_refund",
    {
      title: "Request a refund (LIVE)",
      description: "Asks PayFlow to refund a PayPal capture through one of your workflows. Same checks as a payment; requires refund scope.",
      inputSchema: RefundInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tracked("payflow_request_refund", async (a: z.infer<typeof RefundInput>) => submit("LIVE", "paypal.refund", a)),
  );

  server.registerTool(
    "payflow_test_request",
    {
      title: "Would PayFlow allow this? (TEST)",
      description:
        "Runs the request through the real workflow, authority and analysis in an isolated TEST that cannot reach PayPal or move money, and returns what would happen. A TEST request can never become a live one; its request_id cannot be reused for a live request.",
      inputSchema: TestInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tracked("payflow_test_request", async (a: z.infer<typeof TestInput>) => submit("TEST", a.action === "payout" ? "paypal.payout" : "paypal.refund", a)),
  );

  server.registerTool(
    "payflow_get_request",
    {
      title: "Status of one of your requests",
      description: "Returns the current state, reasons (machine-readable codes), authority decision, human review status, PayPal result and the Intent Receipt for a request this agent made.",
      inputSchema: z
        .object({ reference: z.string().regex(/^PF-[0-9A-Z]{8}$/).optional(), request_id: RequestIdSchema.optional() })
        .strict()
        .refine((v) => !!v.reference !== !!v.request_id, { message: "give exactly one of reference or request_id" }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tracked("payflow_get_request", async (a: { reference?: string; request_id?: string }) => {
      const r = await getAgentRequest(ctx, { reference: a.reference, requestId: a.request_id });
      return r.ok ? ok({ ...r.status, intent_receipt: r.receipt }) : err(r.code, r.message);
    }),
  );

  server.registerTool(
    "payflow_get_authority",
    {
      title: "Limits that govern a workflow",
      description: "Read-only: the authority (amount limits, currencies, recipients, purpose, budget used) that PayFlow will apply to your requests through this workflow. You cannot change it.",
      inputSchema: z.object({ workflow_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tracked("payflow_get_authority", async (a: { workflow_id: string }) => {
      const r = await authoritySummary(ctx, a.workflow_id);
      return r.ok ? ok(r) : err(r.code, r.message);
    }),
  );

  server.registerTool(
    "payflow_cancel_request",
    {
      title: "Withdraw a request waiting for review",
      description: "Withdraws one of your own LIVE requests while it is waiting for a person (REVIEW_REQUIRED). It can only stop a payment, never approve or change one.",
      inputSchema: z.object({ reference: z.string().regex(/^PF-[0-9A-Z]{8}$/) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tracked("payflow_cancel_request", async (a: { reference: string }) => {
      const r = await cancelAgentRequest(ctx, a.reference, deps);
      return r.ok ? ok(r.status as unknown as Json) : err(r.code, r.message);
    }),
  );

  return server;
}
