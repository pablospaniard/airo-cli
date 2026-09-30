import fs from "node:fs";
import path from "node:path";
import { detectDefaultModels } from "./account.js";
import { readHistory } from "./history.js";
import { findRunLogs } from "./logging.js";
import { addTokenUsage, progressFor } from "./runner.js";
import { apiCostForUsage } from "./pricing.js";
import type { Agent, HistoryRecord, RouterConfig, TokenUsage } from "./types.js";

export function nonCachedTokens(usage: TokenUsage): number {
  return usage.uncachedInputTokens + usage.cacheWriteInputTokens + usage.outputTokens;
}

export function processedTokens(usage: TokenUsage): number {
  return nonCachedTokens(usage) + usage.cachedInputTokens;
}

function usageFromEvents(record: HistoryRecord): TokenUsage | undefined {
  if (!record.runId) return undefined;
  const dir = findRunLogs(record.runId);
  if (!dir) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((file: string) => file.endsWith(`-${record.agent}.events.jsonl`))
    .sort();
  const prefix = record.phaseIndex ? `${String(record.phaseIndex).padStart(2, "0")}-` : "01-";
  const file =
    files.find((candidate: string) => candidate.startsWith(prefix)) ??
    (!record.phaseIndex ? files[0] : undefined);
  if (!file) return undefined;
  let total: TokenUsage | undefined;
  for (const line of fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      total = addTokenUsage(total, progressFor(record.agent, JSON.parse(line)).usage);
    } catch {
      /* ignore malformed events */
    }
  }
  return total;
}

export function withRecordedUsage(record: HistoryRecord): HistoryRecord {
  return record.usage ? record : { ...record, usage: usageFromEvents(record) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface SavingsEstimate {
  actualTokens: number;
  baselineTokens: number;
  comparedRecords: number;
  totalRecords: number;
  percent: number;
}

export function estimateDefaultModelSavings(
  selected: HistoryRecord[],
  all: HistoryRecord[],
  defaults: Partial<Record<Agent, string>>,
): SavingsEstimate | undefined {
  let actualTokens = 0;
  let baselineTokens = 0;
  let comparedRecords = 0;

  for (const record of selected) {
    if (!record.usage || record.exitCode !== 0 || record.feedback === "bad") continue;
    const actual = nonCachedTokens(record.usage);
    const defaultModel = defaults[record.agent];
    if (!defaultModel) continue;
    if (record.model === defaultModel) {
      actualTokens += actual;
      baselineTokens += actual;
      comparedRecords++;
      continue;
    }
    const strict = all.filter(
      (candidate) =>
        candidate.usage &&
        candidate.exitCode === 0 &&
        candidate.feedback !== "bad" &&
        candidate.agent === record.agent &&
        candidate.model === defaultModel &&
        candidate.phaseKind === record.phaseKind &&
        Math.abs(candidate.complexity - record.complexity) <= 1,
    );
    const fallback = all.filter(
      (candidate) =>
        candidate.usage &&
        candidate.exitCode === 0 &&
        candidate.feedback !== "bad" &&
        candidate.agent === record.agent &&
        candidate.model === defaultModel &&
        Math.abs(candidate.complexity - record.complexity) <= 1,
    );
    const candidates = strict.length >= 2 ? strict : fallback;
    if (candidates.length < 2) continue;
    actualTokens += actual;
    baselineTokens += median(candidates.map((candidate) => nonCachedTokens(candidate.usage!)));
    comparedRecords++;
  }

  if (!comparedRecords || !baselineTokens) return undefined;
  return {
    actualTokens,
    baselineTokens,
    comparedRecords,
    totalRecords: selected.filter(
      (record) => record.usage && record.exitCode === 0 && record.feedback !== "bad",
    ).length,
    percent: (1 - actualTokens / baselineTokens) * 100,
  };
}

export interface UsageReport {
  records: HistoryRecord[];
  totals: TokenUsage;
  defaults: Partial<Record<Agent, string>>;
  savings?: SavingsEstimate;
}

export type UsagePeriod = "daily" | "weekly" | "monthly" | "lifetime";

export interface ModelCostUsage {
  model: string;
  usage: TokenUsage;
  /** Undefined means the model has no known API list price. */
  apiCost?: number;
}

export interface CostUsageReport {
  period: UsagePeriod;
  records: HistoryRecord[];
  models: ModelCostUsage[];
  totals: TokenUsage;
  /** Sum of only models with known API list prices. */
  apiCost: number;
  unpricedModels: string[];
}

function emptyUsage(): TokenUsage {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function periodStart(period: UsagePeriod, now: Date): Date | undefined {
  if (period === "lifetime") return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "weekly") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "monthly") start.setDate(1);
  return start;
}

/**
 * Builds a local-calendar usage report from every recorded phase in the
 * requested period. Invalid legacy timestamps are excluded from finite periods.
 */
export function buildCostUsageReport(
  config: RouterConfig,
  period: UsagePeriod = "lifetime",
  now = new Date(),
): CostUsageReport {
  const start = periodStart(period, now);
  const records = readHistory(config.history)
    .map(withRecordedUsage)
    .filter(
      (record) =>
        record.usage &&
        (!start ||
          (Number.isFinite(Date.parse(record.timestamp)) &&
            Date.parse(record.timestamp) >= start.getTime())),
    );
  const byModel = new Map<string, TokenUsage>();
  for (const record of records) {
    byModel.set(record.model, addTokenUsage(byModel.get(record.model), record.usage)!);
  }
  const models = [...byModel.entries()]
    .map(([model, usage]) => ({ model, usage, apiCost: apiCostForUsage(model, usage) }))
    .sort((a, b) => a.model.localeCompare(b.model));
  return {
    period,
    records,
    models,
    totals: records.reduce<TokenUsage>(
      (sum, record) => addTokenUsage(sum, record.usage)!,
      emptyUsage(),
    ),
    apiCost: models.reduce((sum, model) => sum + (model.apiCost ?? 0), 0),
    unpricedModels: models
      .filter((model) => model.apiCost === undefined)
      .map((model) => model.model),
  };
}

export function buildUsageReport(
  config: RouterConfig,
  limit = 20,
  cwd = process.cwd(),
): UsageReport {
  // Bound legacy event-log backfills; new records already contain telemetry inline.
  const all = readHistory(config.history).slice(-500).map(withRecordedUsage);
  const records = all.filter((record) => record.usage).slice(-Math.max(1, limit));
  const totals = records.reduce<TokenUsage>(
    (sum, record) => addTokenUsage(sum, record.usage)!,
    emptyUsage(),
  );
  const defaults = detectDefaultModels(config, cwd);
  return {
    records,
    totals,
    defaults,
    savings: estimateDefaultModelSavings(records, all, defaults),
  };
}
