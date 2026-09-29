import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("Jev task sanitization removes attachment lists and local paths", () => {
  const task = [
    "Review /Users/me/secret-project/src/app.ts, src/customer/acme.ts, ./private/config.json,",
    '"C:\\Users\\Jane Doe\\secret app.ts", docs\\Customer Files\\roadmap.md, and ~/secret',
    "",
    "Attached local file(s) for inspection:",
    "- /Users/me/secret-project/private.txt",
    "Use the provider's local file inspection capability if available.",
  ].join("\n");
  const sanitized = sanitizeJevTask(task);
  assert.doesNotMatch(
    sanitized,
    /Users|secret-project|customer|private|Jane Doe|Customer Files|~\/secret|Attached local file/,
  );
  assert.equal(
    sanitized,
    'Review [local-path], [local-path], [local-path],\n"[local-path]", [local-path], and [local-path]',
  );
  assert.equal(
    sanitizeJevTask("Check /repo and https://example.com/docs plus http://localhost/file"),
    "Check [local-path] and https://example.com/docs plus http://localhost/file",
  );
  assert.equal(sanitizeJevTask("Inspect src/app.ts?line=12"), "Inspect [local-path]");
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
    config.enabled = false;
    assert.equal(resetJevFeedback(config), 2);
    assert.deepEqual(readJevFeedback(config), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Jev reset waits for an in-flight append and reports every removed record", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-reset-lock-"));
  const config = historyConfig(directory);
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  const resultFile = path.join(directory, "reset-result");
  let blocker: ReturnType<typeof spawn> | undefined;
  let resetter: ReturnType<typeof spawn> | undefined;
  try {
    appendHistory(config, record("phase-1"));
    enableJev(config);
    const evaluated = await evaluateRunWithJev(config, "run-1", {
      apiKey: "key",
      fetchImpl: async () =>
        new Response(JSON.stringify(answerBody(1)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    assert.equal(evaluated.status, "saved");
    if (evaluated.status !== "saved") return;
    const first = evaluated.records[0];
    const second = { ...first, id: "concurrent-jev-record" };
    const file = jevFeedbackPath(config);
    const lock = `${file}.lock`;
    blocker = spawn(process.execPath, [
      "-e",
      `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(lock)},process.pid+"\\nlegacy\\n",{flag:"wx"});fs.writeFileSync(${JSON.stringify(ready)},"ready");const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);fs.appendFileSync(${JSON.stringify(file)},${JSON.stringify(`${JSON.stringify(second)}\n`)});fs.unlinkSync(${JSON.stringify(lock)})},5);`,
    ]);
    const readyDeadline = Date.now() + 2_000;
    while (!fs.existsSync(ready) && Date.now() < readyDeadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fs.existsSync(ready), true);

    const jevModule = new URL("../jev-feedback.js", import.meta.url).href;
    resetter = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";import {resetJevFeedback} from ${JSON.stringify(jevModule)};fs.writeFileSync(${JSON.stringify(resultFile)},String(resetJevFeedback(${JSON.stringify(config)})));`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(resultFile), false);
    fs.writeFileSync(release, "release");
    await new Promise<void>((resolve, reject) => {
      resetter!.once("exit", (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`reset exited ${code}`)),
      );
      resetter!.once("error", reject);
    });
    assert.equal(fs.readFileSync(resultFile, "utf8"), "2");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.writeFileSync(release, "release");
    blocker?.kill();
    resetter?.kill();
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
    const belowThreshold = jevLearningHints("fix TypeScript parser bug", {
      ...config,
      minimumSamples: 10,
    });
    assert.equal(belowThreshold.observations, 2);
    assert.ok(belowThreshold.confidence > 0 && belowThreshold.confidence < 1);
    assert.deepEqual(belowThreshold.agentBoosts, {
      claude: 0,
      codex: 0,
      gemini: 0,
      copilot: 0,
    });
    disableJev(config);
    assert.equal(jevLearningHints("fix TypeScript parser bug", config).observations, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("assigns repository identity when evaluating legacy history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-legacy-repository-"));
  const config = historyConfig(directory);
  const legacy = record("legacy-phase", "legacy-run");
  try {
    fs.writeFileSync(config.path!, `${JSON.stringify(legacy)}\n`);
    enableJev(config);
    const result = await evaluateRunWithJev(config, "legacy-run", {
      apiKey: "key",
      fetchImpl: async () =>
        new Response(JSON.stringify(answerBody(1)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    assert.equal(result.status, "saved");
    if (result.status === "saved")
      assert.match(result.records[0].repositoryId!, /^(?:git|local)-v1:/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
