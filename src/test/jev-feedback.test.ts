import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractTaskFeatures } from "../evaluation.js";
import { appendHistory } from "../history.js";
import {
  disableJev,
  enableJev,
  evaluateRunWithJev,
  isJevEnabled,
  JEV_MODEL,
  jevConsentPath,
  jevFeedbackPath,
  jevLearningHints,
  readJevConsent,
  readJevFeedback,
  resetJevFeedback,
  sanitizeJevTask,
} from "../jev-feedback.js";
import type { HistoryConfig, HistoryRecord } from "../types.js";

function historyConfig(directory: string): HistoryConfig {
  return {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.2,
    minimumSamples: 1.5,
    halfLifeDays: 90,
    repositoryScoped: false,
    path: path.join(directory, "history.jsonl"),
  };
}

function record(id: string, runId = "run-1"): HistoryRecord {
  const task = "fix TypeScript parser bug";
  return {
    id,
    runId,
    timestamp: new Date().toISOString(),
    cwd: "/private/repository-name",
    task,
    originalTask: task,
    phaseKind: "implement",
    agent: "codex",
    modelTier: "fast",
    model: "secret-model-path",
    effort: "low",
    complexity: 2,
    exitCode: 0,
    durationMs: 2_000,
    outputExcerpt: "PRIVATE_PROVIDER_OUTPUT",
    taskFeatures: extractTaskFeatures(task, 2),
    evaluation: {
      taskSatisfied: true,
      verified: true,
      quality: 1,
      confidence: 0.8,
      signals: ["PRIVATE_SIGNAL"],
    },
    outcome: {
      completion: 1,
      verification: 1,
      retries: 0,
      recoveries: 0,
      regressions: 0,
      durationMs: 2_000,
      tokens: 4_000,
      confidence: 0.8,
    },
  };
}

function answerBody(count: number, suggestion: "agree" | "correct" = "agree") {
  const answers: Record<string, unknown> = {};
  for (let index = 0; index < count; index++) {
    answers[`provider_${index}`] = {
      type: "choice",
      choice: suggestion === "agree" ? "codex" : "claude",
      probabilities:
        suggestion === "agree"
          ? { claude: 0.03, codex: 0.91, gemini: 0.03, copilot: 0.03 }
          : { claude: 0.91, codex: 0.03, gemini: 0.03, copilot: 0.03 },
      confidence: 0.9,
    };
    answers[`tier_${index}`] = {
      type: "choice",
      choice: suggestion === "agree" ? "fast" : "deep",
      probabilities:
        suggestion === "agree"
          ? { fast: 0.92, balanced: 0.05, deep: 0.03 }
          : { fast: 0.03, balanced: 0.05, deep: 0.92 },
      confidence: 0.9,
    };
    answers[`appropriate_${index}`] = {
      type: "noul",
      noul: suggestion === "agree" ? 0.9 : 0.1,
    };
  }
  return { model: JEV_MODEL, answers };
}

test("Jev feedback is default-off and consent is local, versioned, and revocable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-consent-"));
  const config = historyConfig(directory);
  try {
    assert.equal(readJevConsent(config), undefined);
    assert.equal(isJevEnabled(config), false);
    enableJev(config);
    assert.equal(isJevEnabled(config), true);
    assert.equal(fs.statSync(jevConsentPath(config)).mode & 0o777, 0o600);
    disableJev(config);
    assert.equal(isJevEnabled(config), false);
    assert.ok(readJevConsent(config)?.disabledAt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Jev task sanitization removes attachment lists and absolute paths", () => {
  const task = [
    "Review /Users/me/secret-project/src/app.ts and C:\\Users\\me\\secret\\app.ts",
    "",
    "Attached local file(s) for inspection:",
    "- /Users/me/secret-project/private.txt",
    "Use the provider's local file inspection capability if available.",
  ].join("\n");
  const sanitized = sanitizeJevTask(task);
  assert.doesNotMatch(sanitized, /Users|secret-project|Attached local file|private\.txt/);
  assert.match(sanitized, /^Review \[local-path\] and \[local-path\]$/);
  assert.equal(
    sanitizeJevTask("Check /repo and https://example.com/docs"),
    "Check [local-path] and https://example.com/docs",
  );
});

test("post-run evaluation sends a bounded payload and stores validated feedback without secrets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-evaluate-"));
  const config = historyConfig(directory);
  const first = record("phase-1");
  const second = { ...record("phase-2"), phaseKind: "test" as const };
  try {
    appendHistory(config, first);
    appendHistory(config, second);
    enableJev(config);
    let sent = "";
    const result = await evaluateRunWithJev(config, "run-1", {
      apiKey: "PRIVATE_API_KEY",
      fetchImpl: async (_input, init) => {
        assert.ok(init);
        assert.equal(
          (init.headers as Record<string, string>).Authorization,
          "Bearer PRIVATE_API_KEY",
        );
        sent = String(init.body);
        const request = JSON.parse(sent) as { questions: Record<string, unknown> };
        assert.equal(Array.isArray(request.questions), false);
        assert.equal(Object.keys(request.questions).length, 6);
        assert.ok(request.questions.provider_0);
        return new Response(JSON.stringify(answerBody(2)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.equal(result.status, "saved");
    assert.match(sent, /fix TypeScript parser bug/);
    for (const excluded of [
      "PRIVATE_API_KEY",
      "PRIVATE_PROVIDER_OUTPUT",
      "PRIVATE_SIGNAL",
      "/private/repository-name",
      "secret-model-path",
    ])
      assert.doesNotMatch(sent, new RegExp(excluded));
    assert.equal(readJevFeedback(config).length, 2);
    assert.equal(fs.statSync(jevFeedbackPath(config)).mode & 0o777, 0o600);
    const stored = fs.readFileSync(jevFeedbackPath(config), "utf8");
    assert.doesNotMatch(
      stored,
      /fix TypeScript parser bug|PRIVATE_API_KEY|PRIVATE_PROVIDER_OUTPUT/,
    );
    fs.appendFileSync(jevFeedbackPath(config), '{"schemaVersion":1,"id":"broken"}\n');
    assert.equal(readJevFeedback(config).length, 2);
    assert.equal((await evaluateRunWithJev(config, "run-1", { apiKey: "key" })).status, "skipped");
    assert.equal(resetJevFeedback(config), 2);
    assert.deepEqual(readJevFeedback(config), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Jev failures are fail-open and never persist malformed evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-failure-"));
  const config = historyConfig(directory);
  try {
    appendHistory(config, record("phase-1"));
    assert.equal((await evaluateRunWithJev(config, "run-1", { apiKey: "key" })).status, "skipped");
    enableJev(config);
    assert.deepEqual(await evaluateRunWithJev(config, "run-1", { apiKey: "" }), {
      status: "skipped",
      reason: "TYPESAFE_API_KEY is not set",
    });
    const badStatus = await evaluateRunWithJev(config, "run-1", {
      apiKey: "key",
      fetchImpl: async () => new Response("no", { status: 429 }),
    });
    assert.deepEqual(badStatus, { status: "error", reason: "Jev request failed (429)" });
    const wrongModel = await evaluateRunWithJev(config, "run-1", {
      apiKey: "key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ...answerBody(1), model: "jev-other" }), { status: 200 }),
    });
    assert.equal(wrongModel.status, "error");
    const malformed = await evaluateRunWithJev(config, "run-1", {
      apiKey: "key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ model: JEV_MODEL, answers: {} }), { status: 200 }),
    });
    assert.equal(malformed.status, "error");
    assert.deepEqual(readJevFeedback(config), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("accepted Jev evidence requires samples and produces bounded local hints", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-learning-"));
  const config = historyConfig(directory);
  try {
    appendHistory(config, record("phase-1"));
    appendHistory(config, record("phase-2"));
    enableJev(config);
    await evaluateRunWithJev(config, "run-1", {
      apiKey: "key",
      fetchImpl: async () =>
        new Response(JSON.stringify(answerBody(2, "correct")), { status: 200 }),
    });
    const hints = jevLearningHints("fix TypeScript parser bug", config);
    assert.equal(hints.observations, 2);
    assert.ok(hints.agentBoosts.claude > 0);
    assert.ok(hints.agentBoosts.claude <= 1.25);
    assert.ok(hints.tierBoosts.deep > 0);
    assert.ok(hints.tierBoosts.deep <= 0.75);
    assert.match(hints.notes[0], /bounded hint/);
    assert.equal(
      jevLearningHints("fix TypeScript parser bug", { ...config, minimumSamples: 10 }).observations,
      0,
    );
    disableJev(config);
    assert.equal(jevLearningHints("fix TypeScript parser bug", config).observations, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
