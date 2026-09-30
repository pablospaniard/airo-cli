import type { TokenUsage } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import { dataRootDir, ensurePrivateDirectory, ensurePrivateFile } from "./paths.js";

/**
 * Prices are not fetched live; this table is a manually maintained snapshot
 * of provider list prices. Update this date whenever the table changes below.
 */
export let API_PRICES_LAST_UPDATED = "2026-09-30";
export let API_PRICES_SOURCE: "live" | "cache" | "snapshot" = "snapshot";

/** API list prices in USD per million text tokens. */
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
const API_PRICES: Record<string, ModelApiPrice> = {
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

const PRICING_URL = "https://models.dev/api.json";
const PRICING_CACHE = "pricing-cache.json";

type ModelsDevModel = {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  last_updated?: string;
};

function applyCatalog(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  let applied = 0;
  let latest = "";
  for (const provider of Object.values(value as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, rawModel] of Object.entries(models as Record<string, unknown>)) {
      const model = rawModel as ModelsDevModel;
      const cost = model.cost;
      if (!cost || cost.input === undefined || cost.output === undefined) continue;
      API_PRICES[modelId.toLowerCase()] = {
        input: cost.input,
        output: cost.output,
        cachedInput: cost.cache_read ?? cost.input,
        ...(cost.cache_write === undefined ? {} : { cacheWrite: cost.cache_write }),
      };
      applied++;
      if (model.last_updated && model.last_updated > latest) latest = model.last_updated;
    }
  }
  if (latest) API_PRICES_LAST_UPDATED = latest;
  return applied > 0;
}

function loadPricingCache(): boolean {
  try {
    return applyCatalog(
      JSON.parse(fs.readFileSync(path.join(dataRootDir(), PRICING_CACHE), "utf8")),
    );
  } catch {
    return false;
  }
}

/** Refresh prices once per CLI invocation; failures fall back to cache/snapshot. */
export async function refreshApiPrices(): Promise<"live" | "cache" | "snapshot"> {
  try {
    const response = await fetch(PRICING_URL, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    if (!applyCatalog(catalog)) throw new Error("invalid pricing catalog");
    try {
      const root = dataRootDir();
      ensurePrivateDirectory(root);
      fs.writeFileSync(path.join(root, PRICING_CACHE), JSON.stringify(catalog));
      ensurePrivateFile(path.join(root, PRICING_CACHE));
    } catch {}
    API_PRICES_SOURCE = "live";
    return API_PRICES_SOURCE;
  } catch {
    API_PRICES_SOURCE = loadPricingCache() ? "cache" : "snapshot";
    return API_PRICES_SOURCE;
  }
}

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
