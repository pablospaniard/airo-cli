import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("development Jev evaluator validates typed output without exposing fixture text", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-dev-test-"));
  const fakeJev = path.join(directory, "fake-jev");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(
    fakeJev,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") { process.stdout.write("jev-cli-test 1.0.0"); process.exit(0); }
if (process.argv[2] !== "ask") process.exit(10);
const document = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (!document.state?.task || document.questions?.length !== 5) process.exit(11);
if (process.argv[process.argv.indexOf("--model") + 1] !== "jev-1.13.0") process.exit(12);
const response = {
  model: "jev-1.13.0-test",
  answers: {
    task_category: { type: "choice", choice: "research", confidence: 0.9, probabilities: { debug: 0.02, implement: 0.02, review: 0.03, research: 0.9, test: 0.01, general: 0.02 } },
    risk: { type: "choice", choice: "high", confidence: 0.9, probabilities: { low: 0.02, medium: 0.08, high: 0.9 } },
    tier: { type: "choice", choice: "deep", confidence: 0.9, probabilities: { fast: 0.02, balanced: 0.08, deep: 0.9 } },
    provider: { type: "choice", choice: "claude", confidence: 0.9, probabilities: { claude: 0.9, codex: 0.04, gemini: 0.04, copilot: 0.02 } },
    decision_appropriate: { type: "noul", noul: 0.95 }
  },
  usage: { input_tokens: 10, output_tokens: 5 }
};
process.stdout.write(JSON.stringify(response));
`,
  );
  fs.chmodSync(fakeJev, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/evaluate-routing-with-jev.mjs",
        "--model",
        "jev-1.13.0",
        "--jev-command",
        fakeJev,
        "--limit",
        "1",
        "--output",
        output,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.questionSetVersion, "1.0.0");
    assert.equal(report.requestedModel, "jev-1.13.0");
    assert.equal(report.jevCliVersion, "jev-cli-test 1.0.0");
    assert.equal(report.records[0].jev.model, "jev-1.13.0-test");
    assert.equal(report.records[0].agreement.provider, true);
    assert.equal(report.records[0].agreement.tier, true);
    assert.equal(report.records[0].agreement.appropriateProbability, 0.95);
    assert.doesNotMatch(fs.readFileSync(output, "utf8"), /production outage/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("development Jev evaluator rejects malformed typed answers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-malformed-test-"));
  const fakeJev = path.join(directory, "fake-jev");
  fs.writeFileSync(
    fakeJev,
    '#!/usr/bin/env node\nif(process.argv[2]==="--version"){process.stdout.write("jev-cli-test");process.exit(0)}process.stdout.write(JSON.stringify({model:"jev-test",answers:{}}));\n',
  );
  fs.chmodSync(fakeJev, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/evaluate-routing-with-jev.mjs",
        "--model",
        "jev-1.13.0",
        "--jev-command",
        fakeJev,
        "--limit",
        "1",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Malformed Jev choice answer/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("development Jev evaluator rejects unpinned models before making a request", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/evaluate-routing-with-jev.mjs", "--model", "jev-latest", "--limit", "1"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not pinned/);
});
