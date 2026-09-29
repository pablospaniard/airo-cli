import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendFeedback,
  appendHistory,
  explainLearning,
  feedbackPath,
  historyPath,
  learningHints,
  learningStatus,
  newHistoryId,
  newRunId,
  readFeedback,
  readHistory,
  recordImplicitCorrection,
  resetLearning,
  semanticSimilarity,
  setFeedback,
  setScopedFeedback,
  similarity,
  updateHistoryRecord,
} from "../history.js";
import type { HistoryConfig, HistoryRecord } from "../types.js";

test("returns full similarity for equivalent token sets", () => {
  assert.equal(similarity("fix flaky test", "test flaky fix"), 1);
});

test("handles disabled, missing, malformed, and individually rated history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-history-"));
  const file = path.join(dir, "history.jsonl");
  const disabled: HistoryConfig = {
    enabled: false,
    learningEnabled: true,
    similarityThreshold: 0.25,
    path: file,
  };
  const enabled = { ...disabled, enabled: true };
  try {
    assert.equal(historyPath(enabled), file);
    assert.deepEqual(readHistory(disabled), []);
    assert.deepEqual(readHistory(enabled), []);
    appendHistory(disabled, {} as HistoryRecord);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, "not-json\n");
    assert.deepEqual(readHistory(enabled), []);
    assert.throws(() => setFeedback(enabled, "bad"), /No routing history/);

    const record: HistoryRecord = {
      id: "one",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/repo",
      task: "fix parser",
      agent: "claude",
      modelTier: "deep",
      model: "model",
      effort: "high",
      complexity: 2,
      exitCode: 0,
      durationMs: 1,
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    assert.equal(setFeedback(enabled, "bad", "one", "slow")[0].feedbackNote, "slow");
    assert.equal(setFeedback(enabled, "good", "last")[0].feedback, "good");
    assert.throws(() => setFeedback(enabled, "good", "missing"), /not found/);
    assert.match(newHistoryId(), /^[0-9a-f]{32}$/);
    assert.match(newRunId(), /^[0-9a-f]{12}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates history and feedback evidence with private permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-private-history-"));
  const evidenceDir = path.join(dir, "evidence");
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.25,
    path: path.join(evidenceDir, "history.jsonl"),
  };
  const history: HistoryRecord = {
    id: "private-record",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    task: "private task",
    agent: "codex",
    modelTier: "fast",
    model: "model",
    effort: "low",
    complexity: 1,
    exitCode: 0,
    durationMs: 1,
  };
  try {
    appendHistory(config, history);
    appendFeedback(config, {
      id: "private-feedback",
      timestamp: "2026-01-01T00:00:01.000Z",
      scope: "phase",
      targetId: history.id,
      rating: "good",
      source: "explicit",
      confidence: 1,
    });
    assert.equal(fs.statSync(evidenceDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(historyPath(config)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(feedbackPath(config)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derives positive and negative learning hints from similar feedback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-learning-"));
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.2,
    minimumSamples: 0.48,
    path: path.join(dir, "history.jsonl"),
  };
  const base: HistoryRecord = {
    id: "good",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    task: "fix parser bug",
    agent: "claude",
    modelTier: "deep",
    model: "model",
    effort: "high",
    complexity: 2,
    exitCode: 0,
    durationMs: 1,
    feedback: "good",
  };
  try {
    appendHistory(config, base);
    appendHistory(config, {
      ...base,
      id: "bad",
      agent: "codex",
      modelTier: "fast",
      feedback: "bad",
    });
    const hints = learningHints("fix parser bug", config);
    assert.ok(hints.agentBoosts.claude > 0);
    assert.ok(hints.agentBoosts.codex < 0);
    assert.match(hints.notes[0], /2 similar/);
    assert.deepEqual(learningHints("anything", { ...config, learningEnabled: false }).notes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requires enough effective samples before applying agent and tier boosts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-minimum-samples-"));
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.2,
    minimumSamples: 1.9,
    path: path.join(dir, "history.jsonl"),
  };
  const record: HistoryRecord = {
    id: "first",
    timestamp: "2099-01-01T00:00:00.000Z",
    cwd: "/repo",
    task: "fix parser bug",
    agent: "claude",
    modelTier: "deep",
    model: "model",
    effort: "high",
    complexity: 2,
    exitCode: 0,
    durationMs: 1,
    feedback: "good",
  };
  try {
    appendHistory(config, record);
    const belowThreshold = learningHints(record.task, config);
    assert.equal(belowThreshold.agentBoosts.claude, 0);
    assert.equal(belowThreshold.tierBoosts.deep, 0);

    appendHistory(config, { ...record, id: "second" });
    const qualified = learningHints(record.task, config);
    assert.ok(qualified.agentBoosts.claude > 0);
    assert.ok(qualified.tierBoosts.deep > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores common stop words when comparing tasks", () => {
  assert.equal(similarity("fix the parser", "please fix parser"), 1);
});

test("returns zero for unrelated or empty tasks", () => {
  assert.equal(similarity("update parser", "render dashboard"), 0);
  assert.equal(similarity("", "render dashboard"), 0);
});

test("rates every history record belonging to a run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-feedback-"));
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.25,
    path: path.join(dir, "history.jsonl"),
  };
  const base: HistoryRecord = {
    id: "phase-1",
    runId: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    task: "task",
    agent: "codex",
    modelTier: "fast",
    model: "model",
    effort: "low",
    complexity: 1,
    exitCode: 0,
    durationMs: 1,
  };
  try {
    appendHistory(config, base);
    appendHistory(config, { ...base, id: "phase-2" });

    const updated = setFeedback(config, "good", "run-1");

    assert.equal(updated.length, 2);
    assert.deepEqual(
      readHistory(config).map((record) => record.feedback),
      ["good", "good"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stores scoped feedback and exposes inspectable learning state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-scoped-feedback-"));
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.2,
    minimumSamples: 1,
    path: path.join(dir, "history.jsonl"),
  };
  const base: HistoryRecord = {
    id: "phase-1",
    runId: "run-1",
    timestamp: new Date().toISOString(),
    cwd: "/repo",
    task: "fix TypeScript parser bug",
    phaseKind: "implement",
    agent: "codex",
    modelTier: "fast",
    model: "model",
    effort: "low",
    complexity: 2,
    exitCode: 0,
    durationMs: 10,
    outputExcerpt: "Tests passed with 0 failures",
  };

  try {
    assert.match(feedbackPath(config), /history\.feedback\.jsonl$/);
    assert.match(
      feedbackPath({ ...config, path: path.join(dir, "history.data") }),
      /\.feedback\.jsonl$/,
    );
    assert.deepEqual(readFeedback({ ...config, enabled: false }), []);
    assert.deepEqual(readFeedback(config), []);
    appendFeedback(
      { ...config, enabled: false },
      {
        id: "ignored",
        timestamp: base.timestamp,
        scope: "run",
        targetId: "run-1",
        rating: "good",
        source: "explicit",
        confidence: 1,
      },
    );

    appendHistory(config, base);
    appendHistory(config, { ...base, id: "phase-2", phaseKind: "review", agent: "claude" });
    const runFeedback = setScopedFeedback(config, "bad", { note: "needs work" });
    const phaseFeedback = setScopedFeedback(config, "good", {
      scope: "phase",
      targetId: "phase-2",
      source: "implicit",
    });
    assert.equal(runFeedback.targetId, "run-1");
    assert.equal(phaseFeedback.confidence, 0.45);
    assert.throws(
      () => setScopedFeedback(config, "good", { scope: "phase", targetId: "missing" }),
      /not found/,
    );

    fs.appendFileSync(feedbackPath(config), "not-json\n");
    assert.equal(readFeedback(config).length, 2);
    assert.equal(recordImplicitCorrection(config, undefined, "fix that"), undefined);
    assert.equal(recordImplicitCorrection(config, "missing", "fix that"), undefined);
    assert.equal(recordImplicitCorrection(config, "run-1", "looks good"), undefined);
    assert.equal(recordImplicitCorrection(config, "run-1", "fix that"), undefined);

    assert.equal(
      updateHistoryRecord(config, "missing", (record) => record),
      undefined,
    );
    assert.equal(
      updateHistoryRecord(config, "phase-1", (record) => ({ ...record, durationMs: 20 }))
        ?.durationMs,
      20,
    );
    assert.ok(semanticSimilarity("fix TypeScript parser bug", readHistory(config)[0]) > 0.9);

    const hints = learningHints("fix TypeScript parser bug", config);
    assert.equal(hints.observations, 2);
    assert.ok(hints.routeUtilities["codex/model/low"] < 0);

    const status = learningStatus(config);
    assert.equal(status.phases, 2);
    assert.equal(status.explicitFeedback, 1);
    assert.equal(status.implicitFeedback, 1);
    assert.equal(status.evaluatedPhases, 2);
    assert.equal(status.routes[0].samples, 1);

    const explanation = explainLearning(config, "run-1");
    assert.equal(explanation.records.length, 2);
    assert.equal(explanation.feedback.length, 2);
    assert.throws(() => explainLearning(config, "missing"), /not found/);

    setFeedback(config, "good", "phase-1", "legacy");
    assert.equal(resetLearning(config), 2);
    assert.deepEqual(readFeedback(config), []);
    assert.equal(readHistory(config)[0].feedback, undefined);
    assert.equal(resetLearning(config), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("records a high-signal corrective follow-up as implicit feedback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-implicit-feedback-"));
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.2,
    path: path.join(dir, "history.jsonl"),
  };
  try {
    appendHistory(config, {
      id: "phase",
      runId: "run",
      timestamp: new Date().toISOString(),
      cwd: "/repo",
      task: "repair parser",
      agent: "gemini",
      modelTier: "fast",
      model: "model",
      effort: "low",
      complexity: 1,
      exitCode: 0,
      durationMs: 1,
    });
    const feedback = recordImplicitCorrection(config, "run", "that is wrong, try again");
    assert.equal(feedback?.rating, "bad");
    assert.equal(feedback?.source, "implicit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
