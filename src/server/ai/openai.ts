import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { compileUserMessage, patchUserMessage, systemPrompt } from "../workflow/compiler/prompt";
import { CompileEnvelope, PatchEnvelope, type AIProvider, type AIResult, type CompileRequest, type PatchRequest, type Usage } from "./types";

/**
 * OpenAI implementation of AIProvider (Responses API, strict structured
 * outputs). The system prompt is identical to every other provider's and sent
 * first with a fixed cache key so repeated calls hit OpenAI's prompt cache.
 * `store: false` keeps responses out of OpenAI's stored-response history.
 * OpenAI specifics stop at this file: callers only see AIResult and envelopes.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly opts: { maxOutputTokens?: number; effort?: "low" | "medium" | "high" } = {},
    /** Injected in tests; production builds the real client. */
    client?: Pick<OpenAI, "responses">,
  ) {
    // One retry for transient 429/5xx; never loop on paid calls.
    this.client = (client as OpenAI) ?? new OpenAI({ apiKey, maxRetries: 1, timeout: 180_000 });
  }

  compileWorkflow(req: CompileRequest) {
    return this.call(CompileEnvelope, "payflow_compile", compileUserMessage(req.instruction, req.repair));
  }

  patchWorkflow(req: PatchRequest) {
    return this.call(PatchEnvelope, "payflow_patch", patchUserMessage(req));
  }

  private async call<T>(schema: z.ZodType<T>, formatName: string, userMessage: string): Promise<AIResult<T>> {
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create({
        model: this.model,
        instructions: systemPrompt(),
        input: userMessage,
        reasoning: { effort: this.opts.effort ?? "medium" },
        text: { format: zodTextFormat(schema as never, formatName) },
        max_output_tokens: this.opts.maxOutputTokens ?? 16_000,
        prompt_cache_key: "payflow-compiler-v1",
        store: false,
      });
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError) return { ok: false, code: "RATE_LIMITED", message: "The AI provider is rate limiting requests; try again shortly", model: this.model };
      if (err instanceof OpenAI.AuthenticationError) return { ok: false, code: "NOT_CONFIGURED", message: "The AI provider rejected the API key", model: this.model };
      if (err instanceof OpenAI.APIError) return { ok: false, code: "PROVIDER_ERROR", message: `AI provider error ${err.status ?? ""}: ${err.message}`.trim(), model: this.model };
      return { ok: false, code: "PROVIDER_ERROR", message: `AI provider unreachable: ${(err as Error).message}`, model: this.model };
    }

    const u = response.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    const usage: Usage = {
      // OpenAI reports cached tokens as part of input_tokens; split them so each is priced once.
      inputTokens: (u?.input_tokens ?? 0) - cached,
      outputTokens: u?.output_tokens ?? 0,
      cacheWriteTokens: 0,
      cacheReadTokens: cached,
    };
    const requestId = (response as { _request_id?: string | null })._request_id ?? response.id;

    const refused = response.output?.some((o) => o.type === "message" && o.content?.some((c) => c.type === "refusal"));
    if (refused || response.incomplete_details?.reason === "content_filter") {
      return { ok: false, code: "REFUSED", message: "The model declined this request", usage, model: response.model };
    }
    if (response.status === "incomplete") {
      return { ok: false, code: "TRUNCATED", message: `The model's answer was cut off (${response.incomplete_details?.reason ?? "incomplete"})`, usage, model: response.model, raw: response.output_text };
    }
    const raw = response.output_text ?? "";
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
