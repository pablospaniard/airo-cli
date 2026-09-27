import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { orchestrate } from "../orchestrator.js";

function executable(file: string, source: string): string {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function testConfig(claude: string, codex: string) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.claude.command = claude;
  config.codex.command = codex;
  config.history.enabled = false;
  config.logging.persist = false;
  config.logging.level = "compact";
  return config;
}

test("runs a dry adaptive plan without invoking providers", async () => {
  const config = testConfig("missing-claude", "missing-codex");
  const result = await orchestrate("Review this pull request", config, { dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.phases, []);
});

test("includes durable process guidance in adaptive phase prompts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-process-"));
  const promptLog = path.join(dir, "prompt");
  const provider = executable(
    path.join(dir, "provider"),
    `require("node:fs").writeFileSync(${JSON.stringify(promptLog)}, process.argv.at(-1));
console.log(JSON.stringify({type:"result", subtype:"success", result:"done"}));`,
  );
  try {
    const config = testConfig(provider, provider);
    config.orchestration.maxPhases = 1;
    await orchestrate("Start the dev server and leave it running", config);

    const prompt = fs.readFileSync(promptLog, "utf8");
    assert.match(prompt, /tool-managed command session/);
    assert.match(prompt, /tool session ID is not evidence/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("routes each follow-up from the current prompt instead of persisted session models", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-routing-"));
  const provider = executable(
    path.join(dir, "provider"),
    `console.log(JSON.stringify({type:"result", subtype:"success", result:"done"}));`,
  );
  try {
    const result = await orchestrate(
      "switch to Claude Opus model and review this PR",
      testConfig(provider, provider),
      {
        session: {
          sessionId: "routing-session",
          cwd: dir,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          originalTask: "Use Codex",
          turns: [
            {
              turnId: "old-turn",
              runId: "old-run",
              timestamp: new Date(0).toISOString(),
              userPrompt: "fix all, use gpt-5.6-sol model",
              routeSummary: "single:codex/gpt-5.6-sol exit=0",
              phaseSummaries: ["single:codex/gpt-5.6-sol exit=0"],
            },
          ],
        },
      },
    );
    assert.equal(result.phases[0].route.agent, "claude");
    assert.equal(result.phases[0].route.model, DEFAULT_CONFIG.claude.models.deep.model);
    assert.equal(result.phases[0].route.modelTier, "deep");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resumes the same Claude review with elevated permissions after approve", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-approve-"));
  const count = path.join(dir, "count");
  const argsLog = path.join(dir, "args");
  const claude = executable(
    path.join(dir, "claude"),
    `
const fs = require("node:fs");
const countFile = ${JSON.stringify(count)};
const argsFile = ${JSON.stringify(argsLog)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(argsFile, process.argv.slice(2).join(" ") + "\\n");
const result = n === 0 ? "The command needs your approval. Could you approve permission to continue?" : "Review completed.";
console.log(JSON.stringify({type:"result", subtype:"success", result, usage:{input_tokens:2,output_tokens:1}}));
`,
  );
  const codex = executable(
    path.join(dir, "codex"),
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));`,
  );
  try {
    const answers: string[] = [];
    const result = await orchestrate("Review this pull request", testConfig(claude, codex), {
      askUser: async (question) => {
        answers.push(question);
        return "approve";
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].output, "Review completed.");
    assert.equal(result.phases[0].usage?.uncachedInputTokens, 4);
    assert.equal(answers.length, 1);
    assert.match(fs.readFileSync(argsLog, "utf8"), /--permission-mode bypassPermissions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not elevate an affirmative answer to an ordinary clarification", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-clarification-"));
  const count = path.join(dir, "count");
  const argsLog = path.join(dir, "args");
  const claude = executable(
    path.join(dir, "claude"),
    `
const fs = require("node:fs");
const countFile = ${JSON.stringify(count)};
const argsFile = ${JSON.stringify(argsLog)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(argsFile, JSON.stringify(process.argv.slice(2)) + "\\n");
const result = n === 0 ? "AIROUTE_QUESTION: Should I use PostgreSQL?" : "Review completed.";
console.log(JSON.stringify({type:"result", subtype:"success", result}));
`,
  );
  const codex = executable(
    path.join(dir, "codex"),
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));`,
  );
  try {
    const result = await orchestrate("Review this pull request", testConfig(claude, codex), {
      askUser: async () => "yes",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.phases[0].output, "Review completed.");
    const invocations = fs
      .readFileSync(argsLog, "utf8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 2);
    assert.ok(invocations.every((args: string[]) => !args.includes("bypassPermissions")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inserts recovery after an unresolved phase and falls back to an available provider", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-recover-"));
  const count = path.join(dir, "count");
  const codex = executable(
    path.join(dir, "codex"),
    `
const fs = require("node:fs");
const file = ${JSON.stringify(count)};
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(n + 1));
const text = n === 0 ? "Status: unresolved — retry needed." : "Recovered and complete.";
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,cached_input_tokens:2,output_tokens:1}}));
`,
  );
  try {
    const config = testConfig("definitely-missing-claude", codex);
    config.orchestration.maxPhases = 4;
    const result = await orchestrate("Rename a type in one file", config);
    assert.equal(result.exitCode, 0);
    assert.ok(result.phases.some((phase) => phase.phase.kind === "recover"));
    assert.ok(result.phases.every((phase) => phase.route.agent === "codex"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hands the run to the signed-in provider when the routed one is not authenticated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-auth-"));
  // Codex is installed but signed out, exactly as a 401 run reports it.
  const codex = executable(
    path.join(dir, "codex"),
    `if (process.argv.includes("login")) { console.log("Not logged in"); process.exit(0); }
console.log(JSON.stringify({type:"turn.failed",error:{message:"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}));
process.exit(1);`,
  );
  const claude = executable(
    path.join(dir, "claude"),
    `if (process.argv.includes("auth")) { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
console.log(JSON.stringify({type:"result", subtype:"success", result:"Renamed the type."}));`,
  );
  try {
    const config = testConfig(claude, codex);
    config.orchestration.maxPhases = 1;
    const result = await orchestrate("Rename a type in one file", config);

    assert.equal(result.exitCode, 0);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].route.agent, "claude");
    assert.equal(result.phases[0].output, "Renamed the type.");
    assert.ok(
      result.phases[0].route.modelReasons.some((reason: string) =>
        /provider authentication → fallback claude/.test(reason),
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not fall back to a second provider that is also signed out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-both-signed-out-"));
  const codex = executable(
    path.join(dir, "codex"),
    `if (process.argv.includes("login")) { console.log("Not logged in"); process.exit(0); }
console.log(JSON.stringify({type:"turn.failed",error:{message:"unexpected status 401 Unauthorized: Missing bearer"}}));
process.exit(1);`,
  );
  const claudeLog = path.join(dir, "claude-runs");
  const claude = executable(
    path.join(dir, "claude"),
    `const fs = require("node:fs");
if (process.argv.includes("auth")) { console.log(JSON.stringify({loggedIn:false})); process.exit(0); }
fs.appendFileSync(${JSON.stringify(claudeLog)}, "run\\n");
console.log(JSON.stringify({type:"result", subtype:"success", result:"done"}));`,
  );
  try {
    const config = testConfig(claude, codex);
    config.orchestration.maxPhases = 1;
    config.orchestration.recoverOnFailure = false;
    config.orchestration.stopOnFailure = true;
    const result = await orchestrate("Rename a type in one file", config);

    assert.equal(result.exitCode, 1);
    assert.equal(fs.existsSync(claudeLog), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("continues to another installed provider when the first fallback fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-fallback-failure-"));
  const codexRuns = path.join(dir, "codex-runs");
  const claudeRuns = path.join(dir, "claude-runs");
  const geminiRuns = path.join(dir, "gemini-runs");
  const codex = executable(
    path.join(dir, "codex"),
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(codexRuns)}, "run\\n");
console.log(JSON.stringify({type:"turn.failed",error:{message:"unexpected status 401 Unauthorized: Missing bearer"}}));
process.exit(1);`,
  );
  const claude = executable(
    path.join(dir, "claude"),
    `const fs = require("node:fs");
if (process.argv.includes("auth")) { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
fs.appendFileSync(${JSON.stringify(claudeRuns)}, "run\\n");
console.log(JSON.stringify({type:"result", subtype:"error", result:"Claude usage limit reached."}));
process.exit(1);`,
  );
  const gemini = executable(
    path.join(dir, "gemini"),
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(geminiRuns)}, "run\\n");
console.log(JSON.stringify({type:"message",role:"assistant",content:"done"}));`,
  );
  try {
    const config = testConfig(claude, codex);
    config.gemini.command = gemini;
    config.copilot.command = "definitely-missing-copilot";
    config.orchestration.maxPhases = 4;
    const result = await orchestrate("Rename a type in one file", config);

    assert.equal(result.exitCode, 0);
    assert.equal(result.phases.length, 2);
    assert.deepEqual(
      result.phases.map((phase) => phase.route.agent),
      ["gemini", "gemini"],
    );
    assert.equal(fs.readFileSync(codexRuns, "utf8").trim().split("\n").length, 1);
    assert.equal(fs.readFileSync(claudeRuns, "utf8").trim().split("\n").length, 1);
    assert.equal(fs.readFileSync(geminiRuns, "utf8").trim().split("\n").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails instead of substituting a provider when the pinned one is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-pinned-missing-"));
  const codex = executable(
    path.join(dir, "codex"),
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));`,
  );
  try {
    const config = testConfig("definitely-missing-claude", codex);
    await assert.rejects(
      orchestrate("Rename a type in one file", config, {
        routeOverrides: { agent: "claude" },
      }),
      /claude was explicitly selected but definitely-missing-claude is not available/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a pinned provider when it reports a usage limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-pinned-limit-"));
  const codexLog = path.join(dir, "codex-invoked");
  const claude = executable(
    path.join(dir, "claude"),
    `console.log(JSON.stringify({type:"result", subtype:"success", result:"Claude usage limit reached."}));`,
  );
  const codex = executable(
    path.join(dir, "codex"),
    `require("node:fs").writeFileSync(${JSON.stringify(codexLog)}, "yes");
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));`,
  );
  try {
    const config = testConfig(claude, codex);
    config.orchestration.maxPhases = 1;
    config.orchestration.recoverOnFailure = false;
    const result = await orchestrate("Rename a type in one file", config, {
      routeOverrides: { agent: "claude" },
    });
    assert.ok(result.phases.every((phase) => phase.route.agent === "claude"));
    assert.equal(fs.existsSync(codexLog), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not retry a successful run whose answer discusses rate limits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-rate-limit-answer-"));
  const runLog = path.join(dir, "provider-runs");
  const claude = executable(
    path.join(dir, "claude"),
    `require("node:fs").appendFileSync(${JSON.stringify(runLog)}, "claude\\n");
console.log(JSON.stringify({type:"result", subtype:"success", result:"Implemented 429 rate limit handling."}));`,
  );
  const codex = executable(
    path.join(dir, "codex"),
    `require("node:fs").appendFileSync(${JSON.stringify(runLog)}, "codex\\n");
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implemented 429 rate limit handling."}}));`,
  );
  try {
    const config = testConfig(claude, codex);
    config.orchestration.maxPhases = 1;
    const result = await orchestrate("Document rate limits", config);
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(runLog, "utf8").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stops after a failed phase when recovery is disabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-stop-"));
  const codex = executable(path.join(dir, "codex"), `process.exit(2);`);
  try {
    const config = testConfig(codex, codex);
    config.orchestration.recoverOnFailure = false;
    config.orchestration.stopOnFailure = true;
    const result = await orchestrate("Rename a type in one file", config);
    assert.equal(result.exitCode, 1);
    assert.equal(result.phases.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not report success when a provider remains blocked after clarification retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-blocked-"));
  const codex = executable(
    path.join(dir, "codex"),
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"AIROUTE_QUESTION: Permission required to bind the local server. Approve?"}}));`,
  );
  try {
    const config = testConfig(codex, codex);
    const result = await orchestrate("Rename a type in one file", config, {
      askUser: async () => "decline",
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
