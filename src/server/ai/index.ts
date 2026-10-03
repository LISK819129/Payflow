import { env } from "../config/env";
import { AnthropicProvider } from "./anthropic";
import { MeteredProvider } from "./metered";
import { OpenAIProvider } from "./openai";
import type { AIProvider } from "./types";

/** Per-provider defaults: a capable-but-cheap model for compiling, the cheapest for classification. */
export const DEFAULT_MODELS = {
  openai: { compile: "gpt-5.4-mini", fast: "gpt-5.4-nano" },
  anthropic: { compile: "claude-sonnet-5", fast: "claude-haiku-4-5" },
} as const;

export function compileModel() {
  const e = env();
  return e.AI_MODEL_COMPILE ?? DEFAULT_MODELS[e.AI_PROVIDER].compile;
}

export function fastModel() {
  const e = env();
  return e.AI_MODEL_FAST ?? DEFAULT_MODELS[e.AI_PROVIDER].fast;
}

/**
 * The configured workflow-compiler provider, metered against the hard budget,
 * or null when no provider is configured (the UI then shows "setup required").
 * Nothing outside src/server/ai knows which provider is in use.
 */
export function compilerProvider(ctx: { workspaceId?: string | null }): AIProvider | null {
  const e = env();
  if (e.AI_PROVIDER === "openai" && e.OPENAI_API_KEY) {
    return new MeteredProvider(new OpenAIProvider(e.OPENAI_API_KEY, compileModel(), { effort: "medium", maxOutputTokens: e.AI_MAX_OUTPUT_TOKENS }), ctx, {
      inputTokens: 12_000,
      outputTokens: e.AI_MAX_OUTPUT_TOKENS,
    });
  }
  if (e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY) {
    return new MeteredProvider(new AnthropicProvider(e.ANTHROPIC_API_KEY, compileModel(), { effort: "medium", maxTokens: e.AI_MAX_OUTPUT_TOKENS }), ctx, {
      inputTokens: 12_000,
      outputTokens: e.AI_MAX_OUTPUT_TOKENS,
    });
  }
  return null;
}
