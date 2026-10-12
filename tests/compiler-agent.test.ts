import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGatewayForTests } from "@/server/actions/paypal-gateway";
import type { ActionGateway, ActionIntent, ActionOutcome } from "@/server/actions/types";
import { triggerPayload } from "@/server/agents/envelope";
import { handleMcpRequest } from "@/server/agents/http";
import { registerAgent } from "@/server/agents/service";
import { syncAgentRequestForRun } from "@/server/agents/status";
import type { CompileEnvelope } from "@/server/ai/types";
import { closeDb, db } from "@/server/db/client";
import { authorityDecisions, workflows } from "@/server/db/schema";
import { MockAnalysisProvider } from "@/server/intelligence/mock";
import { setAnalysisProviderForTests } from "@/server/intelligence/runner";
import { compileInstruction } from "@/server/workflow/compiler/compile";
import { systemPrompt } from "@/server/workflow/compiler/prompt";
import { AGENT_REQUEST_FIELDS, type WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { validateGraph } from "@/server/workflow/dsl/validate";
import { advanceRun } from "@/server/workflow/runtime/engine";
import type { RuntimeDeps } from "@/server/workflow/runtime/types";
import { activateLatest } from "@/server/workflow/service";
import manualRule from "./fixtures/real-openai/manual-payout-200-graph.json";
import recorded from "./fixtures/real-openai/agent-payout-wrong-field.json";
import { grantAuthority } from "./support/authority";
import { createUser, createWorkspace, resetTestDb } from "./support/db";
import { ScriptedProvider, clarify } from "./support/mock-ai";

/**
 * Regression (2026-10): when a rule named an AI agent, the compiler chose the
 * agent-request trigger but read the recipient from a field agent requests never
 * carry (`trigger.receiver`; they carry `trigger.counterparty`). The validator
 * accepted it, so the workflow could never pay on its own — every request
 * stopped for missing data. The recorded real model output is replayed here.
 *
 * Fixed at the root: one definition of what an agent request carries
 * (AGENT_REQUEST_FIELDS), documented in the compiler prompt and enforced by the
 * validator — where the requester (the agent) is never the recipient.
 */
const ACME = "sb-yluat53193698@personal.example.com";
const AWS = "sb-mnylb53193692@personal.example.com";
const WRONG = recorded.output as unknown as CompileEnvelope;
/** The same real output with the one mistake corrected — what the repair attempt should produce. */
const FIXED = JSON.parse(JSON.stringify(recorded.output).replaceAll("trigger.receiver", "trigger.counterparty")) as CompileEnvelope;

class FakePayPal implements ActionGateway {
  readonly name = "fake-paypal";
  calls: ActionIntent[] = [];
  async execute(intent: ActionIntent): Promise<ActionOutcome> {
    this.calls.push(intent);
    return { status: "succeeded", paypalRefs: [`B-${this.calls.length}`], paypalStatus: "PENDING", debugId: "d", result: {} };
  }
}

let fake: FakePayPal;
let ws: { id: string };
let owner: { id: string };
let queue: string[];
const deps: RuntimeDeps = { enqueueAdvance: async (id) => void queue.push(id), now: () => new Date() };

beforeEach(async () => {
  await resetTestDb();
  ws = await createWorkspace("Demo Company");
  owner = await createUser(ws.id);
  queue = [];
  fake = new FakePayPal();
  setGatewayForTests(fake);
  setAnalysisProviderForTests(new MockAnalysisProvider());
});
afterEach(() => {
  setGatewayForTests(null);
  setAnalysisProviderForTests(undefined);
});
afterAll(closeDb);

const compile = (instruction: string, provider: ScriptedProvider) => compileInstruction({ workspaceId: ws.id, userId: owner.id, instruction, provider });
const savedWorkflows = async () => (await db().select({ n: count() }).from(workflows))[0].n;
const errors = (g: WorkflowGraph) => validateGraph(g).issues.filter((i) => i.severity === "error");

async function connect(token: string) {
  const client = new Client({ name: "compiler-agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://payflow.test/api/mcp"), {
      fetch: (url, init) => handleMcpRequest(new Request(url, init as RequestInit), deps),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  return (r.structuredContent ?? { error: { code: "PROTOCOL", message: (r.content as { text: string }[])[0]?.text } }) as Record<string, unknown> & { state?: string; reference?: string; test?: { verdict: string; headline: string }; error?: { code: string; message?: string } };
}
async function drive() {
  for (let i = 0; i < 60 && queue.length; i++) {
    const id = queue.shift()!;
    await advanceRun(id, deps);
    await syncAgentRequestForRun(id);
  }
}

/** Compile → activate → delegate authority → register an agent that may ask through it. */
async function liveAgentWorkflow(env: CompileEnvelope, instruction: string, agentName = "Cloud Procurement Agent") {
  const r = await compile(instruction, new ScriptedProvider().onCompile({ kind: "ok", value: env }));
  if (r.status !== "COMPILED") throw new Error(`expected COMPILED, got ${r.status}: ${JSON.stringify("problems" in r ? r.problems : "")}`);
  const a = await activateLatest({ workspaceId: ws.id, userId: owner.id, workflowId: r.workflowId });
  if (!a.ok) throw new Error(JSON.stringify(a));
  await grantAuthority(ws.id, owner.id, [r.workflowId], { actions: ["paypal.payout"], counterpartyRule: "allowlist", counterparties: [{ id: ACME, name: "Acme Cloud" }, { id: AWS, name: "AWS" }], perTransactionMax: "500" });
  const agent = await registerAgent({ workspaceId: ws.id, userId: owner.id, name: agentName, scopes: [{ workflowId: r.workflowId, actions: ["paypal.payout"], modes: ["LIVE", "TEST"] }], expiresAt: null });
  if (!agent.ok) throw new Error(agent.error);
  return { workflowId: r.workflowId, graph: r.graph, client: await connect(agent.token) };
}

describe("what an agent request carries is defined once", () => {
  it("the validator's field list is exactly what the gateway puts on the trigger", () => {
    const payload = triggerPayload({ mode: "LIVE", action: "paypal.payout", workflowId: "w", amount: { value: "1.00", currency: "USD" }, counterparty: ACME, captureId: null, purpose: "p", reference: null, evidence: { invoiceText: null, contractText: null } }, { agentRequestId: "r", reference: "PF-00000000", agent: { id: "a", name: "n" } });
    expect(Object.keys(payload).sort()).toEqual(Object.keys(AGENT_REQUEST_FIELDS).sort());
  });

  it("the compiler prompt tells the model those fields, and that the requester is never the recipient", () => {
    const p = systemPrompt();
    expect(p).toContain("trigger.counterparty");
    expect(p).toMatch(/never invent another name/);
    expect(p).toMatch(/requester, never the recipient/);
  });
});

describe("compiling a rule that names an AI agent", () => {
  it("REGRESSION · the recorded real output (recipient read from trigger.receiver) is no longer accepted", () => {
    const problems = errors({ schemaVersion: 1, nodes: WRONG.workflow.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, config: JSON.parse(n.config_json) })), edges: WRONG.workflow.edges } as WorkflowGraph);
    expect(problems.map((p) => p.code)).toEqual(["unknown_agent_field", "unknown_agent_field", "unknown_agent_field"]);
    expect(problems[0].message).toMatch(/reads trigger\.receiver, but an agent request has no "receiver"\. Agent requests carry trigger\.counterparty/);
  });

  it("REGRESSION · the compiler sends that problem back to the model, and saves the corrected workflow", async () => {
    const provider = new ScriptedProvider().onCompile({ kind: "ok", value: WRONG }, { kind: "ok", value: FIXED });
    const r = await compile(recorded.instruction, provider);
    expect(r.status).toBe("COMPILED");
    if (r.status !== "COMPILED") return;
    expect(r.attempts).toBe(2);
    // The repair request names the exact mistake and the right field.
    expect(provider.compileRequests[1].repair?.problems.join(" ")).toMatch(/trigger\.receiver.*trigger\.counterparty/);
    const payout = r.graph.nodes.find((n) => n.type === "paypal.payout")!;
    const gate = r.graph.nodes.find((n) => n.type === "policy.counterparty")!;
    expect(payout.config.receiverRef).toBe("trigger.counterparty");
    expect(gate.config).toMatchObject({ ref: "trigger.counterparty", allowed: [ACME, AWS] }); // the owner's own recipients, unchanged
  });

  it("REGRESSION · if the model repeats the mistake, nothing is saved", async () => {
    const r = await compile(recorded.instruction, new ScriptedProvider().onCompile({ kind: "ok", value: WRONG }, { kind: "ok", value: WRONG }));
    expect(r.status).toBe("INVALID");
    expect(await savedWorkflows()).toBe(0);
  });

  it("A + B · named agent, two allowed recipients: each is paid when asked for, within the rule and the authority", async () => {
    const { workflowId, client } = await liveAgentWorkflow(FIXED, recorded.instruction);

    // Test requests (PayPal never contacted): the workflow now receives the recipient the agent named.
    const test = (id: string, counterparty: string, value: string) => call(client, "payflow_test_request", { request_id: id, workflow_id: workflowId, action: "payout", amount: { value, currency: "USD" }, counterparty, purpose: "Cloud compute" });
    expect((await test("t-acme-180", ACME, "180.00")).test).toMatchObject({ verdict: "WOULD_ALLOW", headline: expect.stringContaining(ACME) });
    expect((await test("t-aws-180", AWS, "180.00")).test).toMatchObject({ verdict: "WOULD_ALLOW", headline: expect.stringContaining(AWS) });
    expect((await test("t-acme-350", ACME, "350.00")).test?.verdict).toBe("WOULD_REVIEW"); // the rule's own "above $200, ask me"
    const other = await test("t-unlisted-50", "someone@elsewhere.example", "50.00");
    expect(other.test?.verdict).toBe("WOULD_DENY");
    expect(fake.calls).toHaveLength(0);

    // A live in-authority request: the authority evaluates, and PayPal is asked to pay, exactly the recipient requested.
    const live = await call(client, "payflow_request_payment", { request_id: "live-acme-25", workflow_id: workflowId, amount: { value: "25.00", currency: "USD" }, counterparty: ACME, purpose: "Cloud compute" });
    await drive();
    expect((await call(client, "payflow_get_request", { reference: live.reference })).state).toBe("SUBMITTED_TO_PAYPAL");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ kind: "paypal.payout", counterparty: ACME, amount: { value: "25.00", currency: "USD" } });
    const [decision] = await db().select().from(authorityDecisions).where(eq(authorityDecisions.workflowId, workflowId));
    expect(decision).toMatchObject({ decision: "ALLOW", request: { counterparty: ACME } });
  });

  it("C · no agent named: a rule a person runs may read whatever fields the person supplies", () => {
    expect(errors((manualRule as unknown as { graph: WorkflowGraph }).graph)).toEqual([]);
  });

  it("D · an ambiguous recipient becomes a question, never an invented address", async () => {
    const instruction = "Let the Cloud Procurement Agent pay Acme Cloud in USD up to $200 for cloud infrastructure. Anything above $200 should require my approval.";
    // The model asks (the normal case)…
    const asked = await compile(instruction, new ScriptedProvider().onCompile({ kind: "ok", value: clarify(["recipient", "Which PayPal email address is Acme Cloud paid at?"]) }));
    expect(asked.status).toBe("NEEDS_CLARIFICATION");
    // …and if it guesses an address the owner never gave, PayFlow refuses to save it.
    const guessed = JSON.parse(JSON.stringify(FIXED).replaceAll(ACME, "billing@acme-cloud.example").replaceAll(`,\\"${AWS}\\"`, "")) as CompileEnvelope;
    const r = await compile(instruction, new ScriptedProvider().onCompile({ kind: "ok", value: guessed }));
    expect(r.status).toBe("NEEDS_CLARIFICATION");
    if (r.status === "NEEDS_CLARIFICATION") expect(r.ungrounded.map((u) => u.value)).toContain("billing@acme-cloud.example");
    expect(await savedWorkflows()).toBe(0);
  });

  it("E · an agent whose name resembles a supplier is still only the requester", async () => {
    const instruction = `Let the Acme Procurement Agent pay ${ACME} (Acme Cloud) in USD up to $200. Anything above $200 should require my approval.`;
    const oneSupplier = JSON.parse(JSON.stringify(FIXED).replaceAll(`,\\"${AWS}\\"`, "")) as CompileEnvelope;
    const graphOf = (env: CompileEnvelope) => ({ schemaVersion: 1, nodes: env.workflow.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, config: JSON.parse(n.config_json) })), edges: env.workflow.edges }) as WorkflowGraph;

    // The model confuses who asks with who is paid: recipient read from the agent…
    const fromAgent = JSON.parse(JSON.stringify(oneSupplier).replaceAll("trigger.counterparty", "trigger.agent.name")) as CompileEnvelope;
    expect(errors(graphOf(fromAgent)).map((p) => p.code)).toContain("requester_not_recipient");
    // …or the agent's name put on the allowlist.
    const nameAllowed = JSON.parse(JSON.stringify(oneSupplier).replaceAll(ACME, "Acme Procurement Agent")) as CompileEnvelope;
    expect(errors(graphOf(nameAllowed)).map((p) => p.code)).toContain("unmatchable_counterparty");
    for (const bad of [fromAgent, nameAllowed]) expect((await compile(instruction, new ScriptedProvider().onCompile({ kind: "ok", value: bad }, { kind: "ok", value: bad }))).status).toBe("INVALID");
    expect(await savedWorkflows()).toBe(0);

    // Compiled correctly, the agent's name grants it nothing: only the supplier's address is paid.
    const { workflowId, client } = await liveAgentWorkflow(oneSupplier, instruction, "Acme Cloud");
    const test = (id: string, counterparty: string) => call(client, "payflow_test_request", { request_id: id, workflow_id: workflowId, action: "payout", amount: { value: "100.00", currency: "USD" }, counterparty, purpose: "Cloud compute" });
    expect((await test("e-supplier", ACME)).test?.verdict).toBe("WOULD_ALLOW");
    expect((await test("e-agent-itself", "acme.cloud.agent@agents.example")).test?.verdict).toBe("WOULD_DENY");
    expect(fake.calls).toHaveLength(0);
  });
});
