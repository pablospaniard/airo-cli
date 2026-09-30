import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import {
  buildUsageReport,
  buildCostUsageReport,
  estimateDefaultModelSavings,
  nonCachedTokens,
  processedTokens,
  withRecordedUsage,
} from "../usage.js";
import type { HistoryRecord, TokenUsage } from "../types.js";

function usage(nonCached: number, cached = 0): TokenUsage {
  return {
    uncachedInputTokens: nonCached - 10,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 0,
  };
}

function record(id: string, model: string, tokens: number): HistoryRecord {
  return {
    id,
    timestamp: "2026-01-01T00:00:00Z",
    cwd: "/repo",
    task: "task",
    agent: "codex",
    modelTier: "fast",
    model,
    effort: "low",
    complexity: 2,
    exitCode: 0,
    durationMs: 1,
    phaseKind: "implement",
    usage: usage(tokens),
  };
}

test("counts cache reads separately from non-cached tokens", () => {
  const value = usage(100, 400);
  assert.equal(nonCachedTokens(value), 100);
  assert.equal(processedTokens(value), 500);
});

test("groups API-equivalent usage by model and period without pricing unknown models", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cost-usage-"));
  const historyFile = path.join(home, "history.jsonl");
  const entries = [
    {
      ...record("today", "gpt-5.6-luna", 100),
      timestamp: "2026-01-15T10:00:00Z",
      usage: {
        uncachedInputTokens: 90,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      },
    },
    { ...record("unknown", "private-model", 20), timestamp: "2026-01-15T11:00:00Z" },
    { ...record("older", "gemini-2.5-flash", 50), timestamp: "2025-12-31T10:00:00Z" },
  ];
  fs.writeFileSync(historyFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.history.path = historyFile;
    const daily = buildCostUsageReport(config, "daily", new Date("2026-01-15T12:00:00Z"));
    assert.deepEqual(
      daily.models.map((entry) => entry.model),
      ["gpt-5.6-luna", "private-model"],
    );
    assert.equal(daily.unpricedModels[0], "private-model");
    assert.equal(daily.models[0].apiCost, 0.0000314);
    assert.equal(daily.apiCost, 0.0000314);

    const monthly = buildCostUsageReport(config, "monthly", new Date("2026-01-15T12:00:00Z"));
    assert.equal(monthly.records.length, 2);
    assert.equal(buildCostUsageReport(config, "lifetime").records.length, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("handles direct default-model records and fallback baselines", () => {
  const direct = record("direct", "default-model", 120);
  const estimate = estimateDefaultModelSavings([direct], [direct], { codex: "default-model" });
  assert.equal(estimate?.actualTokens, 120);
  assert.equal(estimate?.baselineTokens, 120);
  assert.equal(estimate?.percent, 0);

  const routed = { ...record("routed", "fast", 100), phaseKind: "test" as const };
  const baselines = [record("b1", "default-model", 200), record("b2", "default-model", 220)];
  assert.equal(
    estimateDefaultModelSavings([routed], [routed, ...baselines], { codex: "default-model" })
      ?.baselineTokens,
    210,
  );
  assert.equal(
    estimateDefaultModelSavings([{ ...routed, usage: undefined }], baselines, {
      codex: "default-model",
    }),
    undefined,
  );
  assert.equal(estimateDefaultModelSavings([routed], baselines, {}), undefined);
});

test("recovers usage from event logs and builds a bounded report", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-usage-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const historyFile = path.join(home, "history.jsonl");
  const runDir = path.join(home, ".local", "share", "airo", "logs", "standalone", "run-run-1");
  fs.mkdirSync(runDir, { recursive: true });
  const base = {
    ...record("one", "default-model", 100),
    runId: "run-1",
    phaseIndex: 1,
    usage: undefined,
  };
  fs.writeFileSync(
    path.join(runDir, "01-test-codex.events.jsonl"),
    [
      "bad-json",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 },
      }),
      "",
    ].join("\n"),
  );
  fs.writeFileSync(historyFile, `${JSON.stringify(base)}\n`);
  try {
    const recovered = withRecordedUsage(base);
    assert.equal(recovered.usage?.uncachedInputTokens, 10);
    assert.equal(withRecordedUsage({ ...base, usage: usage(50) }).usage?.outputTokens, 10);
    assert.equal(withRecordedUsage({ ...base, runId: undefined }).usage, undefined);
    assert.equal(withRecordedUsage({ ...base, runId: "missing" }).usage, undefined);

    const config = structuredClone(DEFAULT_CONFIG);
    config.history.path = historyFile;
    config.codex.defaultModel = "default-model";
    const report = buildUsageReport(config, 0, home);
    assert.equal(report.records.length, 1);
    assert.equal(report.totals.uncachedInputTokens, 10);
    assert.equal(report.defaults.codex, "default-model");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("estimates savings from comparable measured default-model runs", () => {
  const selected = [record("routed", "fast-model", 100)];
  const all = [
    ...selected,
    record("baseline-1", "default-model", 200),
    record("baseline-2", "default-model", 300),
  ];
  const estimate = estimateDefaultModelSavings(selected, all, { codex: "default-model" });

  assert.equal(estimate?.baselineTokens, 250);
  assert.equal(estimate?.actualTokens, 100);
  assert.equal(estimate?.percent, 60);
  assert.equal(estimate?.comparedRecords, 1);
});

test("withholds comparison when no measured default baseline exists", () => {
  const selected = [record("routed", "fast-model", 100)];
  assert.equal(
    estimateDefaultModelSavings(selected, selected, { codex: "default-model" }),
    undefined,
  );
});
