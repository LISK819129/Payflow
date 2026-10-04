import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { compileUserMessage, patchUserMessage, systemPrompt } from "../workflow/compiler/prompt";
import { CompileEnvelope, PatchEnvelope, type AIProvider, type AIResult, type AnalysisRequest, type CompileRequest, type PatchRequest, type Usage } from "./types";

/**
 * Anthropic implementation of AIProvider. Uses structured outputs so the
 * response matches the envelope, then re-parses it with PayFlow's own schema
 * (defence in depth). Anthropic specifics stop at this file: callers only ever
 * see AIResult and the envelope types.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly opts: { maxTokens?: number; effort?: "low" | "medium" | "high" } = {},
    /** Injected in tests; production builds the real client. */
    client?: Pick<Anthropic, "messages">,
  ) {
    // One retry for transient 429/5xx; never loop on expensive calls.
    this.client = (client as Anthropic) ?? new Anthropic({ apiKey, maxRetries: 1, timeout: 180_000 });
  }

  compileWorkflow(req: CompileRequest) {
    return this.call(CompileEnvelope, compileUserMessage(req.instruction, req.repair));
  }

  patchWorkflow(req: PatchRequest) {
    return this.call(PatchEnvelope, patchUserMessage(req));
  }

  analyze<T>(req: AnalysisRequest<T>) {
    return this.call(req.schema, req.input, { system: req.instructions, effort: "low", maxTokens: 3000 });
  }

  private async call<T>(schema: z.ZodType<T>, userMessage: string, o: { system?: string; effort?: "low" | "medium" | "high"; maxTokens?: number } = {}): Promise<AIResult<T>> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: o.maxTokens ?? this.opts.maxTokens ?? 16_000,
        // Stable system prompt, cached: repeated calls pay ~10% for it.
        system: [{ type: "text", text: o.system ?? systemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage }],
        thinking: { type: "adaptive" },
        output_config: { effort: o.effort ?? this.opts.effort ?? "medium", format: zodOutputFormat(schema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return { ok: false, code: "RATE_LIMITED", message: "The AI provider is rate limiting requests; try again shortly", model: this.model };
      if (err instanceof Anthropic.AuthenticationError) return { ok: false, code: "NOT_CONFIGURED", message: "The AI provider rejected the API key", model: this.model };
      if (err instanceof Anthropic.APIError) return { ok: false, code: "PROVIDER_ERROR", message: `AI provider error ${err.status ?? ""}: ${err.message}`.trim(), model: this.model };
      return { ok: false, code: "PROVIDER_ERROR", message: `AI provider unreachable: ${(err as Error).message}`, model: this.model };
    }

    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const requestId = (response as { _request_id?: string | null })._request_id ?? undefined;
    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (response.stop_reason === "refusal") {
      return { ok: false, code: "REFUSED", message: "The model declined this request", usage, model: response.model, raw };
    }
    if (response.stop_reason === "max_tokens") {
      return { ok: false, code: "TRUNCATED", message: "The model's answer was cut off before it finished", usage, model: response.model, raw };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, code: "MALFORMED_OUTPUT", message: "The model did not return valid JSON", usage, model: response.model, raw };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, code: "MALFORMED_OUTPUT", message: `The model's JSON did not match the expected shape: ${parsed.error.issues[0]?.message ?? ""}`, usage, model: response.model, raw };
    }
    return { ok: true, value: parsed.data, usage, model: response.model, requestId, raw };
  }
}
