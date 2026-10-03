import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "@/server/ai/openai";
import { costOf, priceFor } from "@/server/ai/pricing";
import { approvalEnvelope } from "./support/envelopes";

type Captured = Record<string, unknown>;

function fakeClient(response: Record<string, unknown>, captured: Captured[] = []) {
  return {
    responses: {
      create: async (params: Captured) => {
        captured.push(params);
        return {
          id: "resp_test",
          model: "gpt-5.4-mini-2026-03-17",
          status: "completed",
          incomplete_details: null,
          output: [],
          usage: { input_tokens: 4200, input_tokens_details: { cached_tokens: 3800 }, output_tokens: 1800, output_tokens_details: { reasoning_tokens: 900 } },
          _request_id: "req_test",
          ...response,
        };
      },
    },
  } as never;
}

const text = (t: string) => ({ output_text: t, output: [{ type: "message", content: [{ type: "output_text", text: t }] }] });

describe("OpenAIProvider (stubbed SDK, no network)", () => {
  it("sends instructions first with a fixed cache key, strict structured output, store=false; splits cached tokens", async () => {
    const calls: Captured[] = [];
    const p = new OpenAIProvider("k", "gpt-5.4-mini", { effort: "medium" }, fakeClient(text(JSON.stringify(approvalEnvelope())), calls));
    const r = await p.compileWorkflow({ instruction: "When a payment over $400 arrives, ask me." });
    expect(r).toMatchObject({ ok: true, model: "gpt-5.4-mini-2026-03-17", requestId: "req_test", usage: { inputTokens: 400, cacheReadTokens: 3800, outputTokens: 1800, cacheWriteTokens: 0 } });
    const req = calls[0] as { instructions: string; input: string; prompt_cache_key: string; store: boolean; reasoning: { effort: string }; text: { format: { type: string; strict: boolean } }; temperature?: unknown };
    expect(req.instructions).toContain("You are the workflow compiler inside PayFlow");
    expect(req.input).toContain("<instruction>\nWhen a payment over $400 arrives, ask me.\n</instruction>");
    expect(req.prompt_cache_key).toBe("payflow-compiler-v1");
    expect(req.store).toBe(false);
    expect(req.reasoning.effort).toBe("medium");
    expect(req.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(req.temperature).toBeUndefined();
  });

  it("never turns refusals, truncation or bad JSON into a workflow", async () => {
    const run = (resp: Record<string, unknown>) => new OpenAIProvider("k", "gpt-5.4-mini", {}, fakeClient(resp)).compileWorkflow({ instruction: "x payment workflow" });
    expect(await run(text("Here is your workflow!"))).toMatchObject({ ok: false, code: "MALFORMED_OUTPUT" });
    expect(await run(text(JSON.stringify({ status: "compiled", workflow: { nodes: "lots" } })))).toMatchObject({ ok: false, code: "MALFORMED_OUTPUT" });
    expect(await run({ output_text: "", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })).toMatchObject({ ok: false, code: "REFUSED" });
    expect(await run({ ...text('{"status":"compiled",'), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toMatchObject({ ok: false, code: "TRUNCATED" });
  });

  it("prices dated snapshots as their base model, with cached input at 10%", () => {
    expect(priceFor("gpt-5.4-mini-2026-03-17")).toEqual({ input: 0.75, output: 4.5 });
    // 400 × 0.75 + 3800 × 0.075 + 1800 × 4.5 = 300 + 285 + 8100 micro-dollars
    expect(costOf("gpt-5.4-mini-2026-03-17", { inputTokens: 400, cacheReadTokens: 3800, outputTokens: 1800, cacheWriteTokens: 0 })).toBe("0.008685");
  });
});
