import { env } from "../config/env";
import { AnthropicProvider } from "./anthropic";
import { MeteredProvider } from "./metered";
import type { AIProvider } from "./types";

/** Strong model for compiling and editing workflows. */
export const DEFAULT_COMPILE_MODEL = "claude-sonnet-5";
/** Cheapest capable model for classification/extraction (Phase 7). */
export const DEFAULT_FAST_MODEL = "claude-haiku-4-5";

/**
 * The configured workflow-compiler provider, metered against the hard budget,
 * or null when no provider is configured (the UI then shows "setup required").
 */
export function compilerProvider(ctx: { workspaceId?: string | null }): AIProvider | null {
  const e = env();
  if (e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY) {
    return new MeteredProvider(new AnthropicProvider(e.ANTHROPIC_API_KEY, e.AI_MODEL_COMPILE ?? DEFAULT_COMPILE_MODEL, { effort: "medium" }), ctx);
  }
  return null;
}
