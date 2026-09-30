import type { TokenUsage } from "./types.js";

/** API list prices in USD per million text tokens. Updated 2026-09-30. */
export interface ModelApiPrice {
  input: number;
  cachedInput: number;
  output: number;
  /** Provider cache-write price, when it differs from standard input. */
  cacheWrite?: number;
}

/*
 * This is deliberately an allow-list. Model catalogues can contain private,
 * subscription-only, gateway, and preview models; estimating a price for one
 * of those would be more misleading than showing "unpriced".
 */
const API_PRICES: Readonly<Record<string, ModelApiPrice>> = {
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  // Claude Code's stable aliases resolve to these current API-priced models.
  haiku: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  sonnet: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  opus: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-haiku-4.5": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  "claude-sonnet-4.5": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-sonnet-4-5": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-sonnet-4.6": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-opus-4.5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "gemini-2.5-flash": { input: 0.3, cachedInput: 0.03, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, cachedInput: 0.125, output: 10 },
};

export function apiPriceForModel(model: string): ModelApiPrice | undefined {
  return API_PRICES[model.toLowerCase()];
}

/** Returns undefined instead of inventing a price for an unrecognised model. */
export function apiCostForUsage(model: string, usage: TokenUsage): number | undefined {
  const price = apiPriceForModel(model);
  if (!price) return undefined;
  return (
    (usage.uncachedInputTokens * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.cacheWriteInputTokens * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
