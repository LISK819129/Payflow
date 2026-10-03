import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/server/ai/anthropic";
import { approvalEnvelope } from "./support/envelopes";

type Captured = Record<string, unknown>;

function fakeClient(response: Record<string, unknown>, captured: Captured[] = []) {
  return {
    messages: {
      create: async (params: Captured) => {
        captured.push(params);
        return { model: "claude-sonnet-5", usage: { input_tokens: 420, output_tokens: 900, cache_creation_input_tokens: 3500, cache_read_input_tokens: 0 }, _request_id: "req_test", ...response };
      },
    },
  } as never;
}

const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

describe("AnthropicProvider (stubbed SDK, no network)", () => {
  it("sends a cached system prompt, adaptive thinking and a structured-output format; parses valid output", async () => {
    const calls: Captured[] = [];
    const p = new AnthropicProvider("k", "claude-sonnet-5", { effort: "medium" }, fakeClient(text(JSON.stringify(approvalEnvelope())), calls));
    const r = await p.compileWorkflow({ instruction: "When a payment over $400 arrives, ask me." });
    expect(r).toMatchObject({ ok: true, model: "claude-sonnet-5", requestId: "req_test", usage: { inputTokens: 420, outputTokens: 900, cacheWriteTokens: 3500 } });
    const req = calls[0] as { system: { cache_control: unknown }[]; thinking: unknown; output_config: { effort: string; format: { type: string } }; temperature?: unknown; messages: { content: string }[] };
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config.effort).toBe("medium");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.temperature).toBeUndefined();
    expect(req.messages[0].content).toContain("<instruction>\nWhen a payment over $400 arrives, ask me.\n</instruction>");
  });

  it("reports non-JSON, schema-mismatched, refused and truncated responses as errors, never as workflows", async () => {
    const run = (resp: Record<string, unknown>) => new AnthropicProvider("k", "claude-sonnet-5", {}, fakeClient(resp)).compileWorkflow({ instruction: "x payment workflow" });
    expect(await run(text("Here is your workflow!"))).toMatchObject({ ok: false, code: "MALFORMED_OUTPUT" });
    expect(await run(text(JSON.stringify({ status: "compiled", workflow: { nodes: "lots" } })))).toMatchObject({ ok: false, code: "MALFORMED_OUTPUT" });
    expect(await run({ content: [], stop_reason: "refusal" })).toMatchObject({ ok: false, code: "REFUSED" });
    expect(await run({ ...text('{"status":"compiled",'), stop_reason: "max_tokens" })).toMatchObject({ ok: false, code: "TRUNCATED" });
  });
});
