import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { RunLogger } from "../logging.js";
import { routeTask } from "../router.js";
import {
  addTokenUsage,
  classifyProviderFailure,
  claudeProgress,
  codexProgress,
  commandExists,
  commandVersion,
  extractQuestion,
  geminiProgress,
  isApprovalAnswer,
  isPermissionApproval,
  isProviderAuthError,
  isProviderUnavailableError,
  isUsageLimitError,
  permissionFailureQuestion,
  progressFor,
  runAgent,
} from "../runner.js";

test("detects provider session and quota limit failures", () => {
  assert.equal(isUsageLimitError("You've hit your session limit."), true);
  assert.equal(isUsageLimitError("rate_limit_error: too many requests"), true);
  assert.equal(isUsageLimitError("Authentication failed"), false);
});

test("detects provider sign-in failures that need another provider", () => {
  const codex401 =
    "Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses)\nturn failed: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";

  assert.equal(isProviderAuthError(codex401, 1), true);
  assert.equal(isProviderUnavailableError(codex401, 1), true);
  assert.equal(isProviderAuthError("Please run `codex login` first", 1), true);
  assert.equal(isProviderAuthError("You are not logged in", 2), true);
  // A 401 the agent ran into while working on the task is not a provider failure.
  assert.equal(isProviderAuthError(`curl returned 401 Unauthorized for the staging API`, 0), false);
  assert.equal(isProviderAuthError("Review completed.", 1), false);
  assert.equal(isProviderUnavailableError("You've hit your session limit.", 1), true);
});

test("classifies fallback failures through every provider adapter", () => {
  for (const agent of ["claude", "codex", "gemini", "copilot"] as const) {
    assert.equal(classifyProviderFailure(agent, "rate_limit_error", 1), "usage limit");
    assert.equal(classifyProviderFailure(agent, "Authentication failed", 1), "authentication");
    assert.equal(classifyProviderFailure(agent, "Task failed for another reason", 1), undefined);
    assert.equal(classifyProviderFailure(agent, "401 Unauthorized", 0), undefined);
  }
});

test("extracts explicit and permission-blocked clarification questions", () => {
  assert.equal(
    extractQuestion("AIROUTE_QUESTION: Which database should I use?"),
    "Which database should I use?",
  );
  assert.equal(
    extractQuestion(
      "The command needs your approval to run — could you approve it, or should I proceed with a manual review instead?",
    ),
    "The command needs your approval to run — could you approve it, or should I proceed with a manual review instead?",
  );
});

test("does not mistake an optional closing offer for blocking input", () => {
  assert.equal(
    extractQuestion(
      "The review is complete and no issues were found.\n\nWould you like me to open a PR?",
    ),
    undefined,
  );
});

test("turns concrete permission and connection failures into approval questions", () => {
  assert.equal(
    permissionFailureQuestion("fatal: could not open config: Permission denied"),
    "Permission required to retry the blocked action with elevated access. Approve?",
  );
  assert.equal(
    permissionFailureQuestion(
      "I couldn't retrieve the PR comments: GitHub API access is currently unavailable (gh pr view failed with a connection error).",
    ),
    "Permission required to access GitHub and retry the blocked action. Approve?",
  );
  assert.equal(
    permissionFailureQuestion(
      "GitHub authentication cannot connect to github.com. Please authenticate manually.",
    ),
    "Permission required to access GitHub and retry the blocked action. Approve?",
  );
  assert.equal(
    permissionFailureQuestion(
      "GitHub API access is blocked, so I can't open the PR. Please enable network access.",
    ),
    "Permission required to access GitHub and retry the blocked action. Approve?",
  );
  assert.equal(
    permissionFailureQuestion(
      "GitHub authentication is still invalid. Please re-authenticate `gh` with `gh auth login -h github.com`, then retry?",
    ),
    "Permission required to access GitHub and retry the blocked action. Approve?",
  );
  assert.equal(
    permissionFailureQuestion(
      "The command needs your approval. Could you approve permission to continue?",
    ),
    "Permission required to retry the blocked action with elevated access. Approve?",
  );
  assert.equal(
    permissionFailureQuestion("The review completed. Permission handling looks correct."),
    undefined,
  );
});

test("accepts natural affirmative answers as permission approval", () => {
  assert.equal(isApprovalAnswer("approve"), true);
  assert.equal(isApprovalAnswer(" APPROVED "), true);
  assert.equal(isApprovalAnswer("yes"), true);
  assert.equal(isApprovalAnswer("y"), true);
  assert.equal(isApprovalAnswer("allow"), true);
  assert.equal(isApprovalAnswer("proceed manually"), false);
});

test("only elevates natural affirmative answers to permission questions", () => {
  assert.equal(isPermissionApproval("Permission required to access GitHub. Approve?", "yes"), true);
  assert.equal(
    isPermissionApproval("The command needs your approval before it can continue.", "yes"),
    false,
  );
  assert.equal(isPermissionApproval("Should I use PostgreSQL?", "yes"), false);
  assert.equal(isPermissionApproval("Proceed with the proposed design?", "proceed"), false);
});

test("parses Claude lifecycle, tool, retry, result, and usage events", () => {
  assert.deepEqual(claudeProgress(null), { messages: [] });
  assert.match(
    claudeProgress({ type: "system", subtype: "init", model: "m", session_id: "s" }).messages[0]
      .text,
    /model=m session=s/,
  );
  assert.match(
    claudeProgress({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 2,
      retry_delay_ms: 50,
      error: "busy",
    }).messages[0].text,
    /1\/2/,
  );
  assert.match(
    claudeProgress({ type: "system", subtype: "plugin_install", status: "done", name: "plug" })
      .messages[0].text,
    /plug/,
  );
  assert.match(
    claudeProgress({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x" } }] },
    }).messages[0].text,
    /Bash/,
  );
  assert.match(
    claudeProgress({ type: "tool", tool_name: "Read", input: { path: "x" } }).messages[0].text,
    /Read/,
  );
  const result = claudeProgress({
    type: "result",
    subtype: "success",
    duration_ms: 1499,
    result: "done",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens: 4,
    },
  });
  assert.match(result.messages[0].text, /1s/);
  assert.deepEqual(result.usage, {
    uncachedInputTokens: 10,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 4,
    reasoningOutputTokens: 0,
  });
});

test("parses every Codex progress event family", () => {
  assert.deepEqual(codexProgress(undefined), { messages: [] });
  assert.match(codexProgress({ type: "thread.started", thread_id: "t" }).messages[0].text, /t/);
  assert.match(codexProgress({ type: "turn.started" }).messages[0].text, /turn started/);
  assert.match(
    codexProgress({ type: "turn.failed", error: { message: "bad" } }).messages[0].text,
    /bad/,
  );
  assert.match(codexProgress({ type: "error", message: "oops" }).messages[0].text, /oops/);
  const completed = codexProgress({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 4,
      cache_write_input_tokens: 2,
      output_tokens: 3,
      reasoning_output_tokens: 1,
    },
  });
  assert.deepEqual(completed.usage, {
    uncachedInputTokens: 6,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  });
  for (const item of [
    { type: "command_execution", command: "echo ok" },
    { type: "file_change", path: "a.ts" },
    { type: "file_changes", changes: [{ path: "b.ts" }] },
    { type: "mcp_tool_call", server: "s", tool: "t" },
    { type: "web_search", query: "q" },
    { type: "reasoning" },
    { type: "unknown" },
  ])
    assert.ok(codexProgress({ type: "item.started", item }).messages.length);
  assert.match(
    codexProgress({ type: "item.completed", item: { type: "command_execution", exit_code: 2 } })
      .messages[0].text,
    /exit 2/,
  );
  assert.match(
    codexProgress({ type: "item.completed", item: { type: "mcp_tool_call", name: "tool" } })
      .messages[0].text,
    /completed/,
  );
  assert.equal(progressFor("claude", { type: "result", result: "c" }).finalOutput, "c");
  assert.equal(
    progressFor("codex", { type: "item.completed", item: { type: "agent_message", text: "x" } })
      .candidateOutput,
    "x",
  );
});

test("adds token usage and checks local commands", () => {
  const a = {
    uncachedInputTokens: 1,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 3,
    outputTokens: 4,
    reasoningOutputTokens: 5,
  };
  assert.equal(addTokenUsage(undefined, a), a);
  assert.equal(addTokenUsage(a, undefined), a);
  assert.deepEqual(addTokenUsage(a, a), {
    uncachedInputTokens: 2,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 6,
    outputTokens: 8,
    reasoningOutputTokens: 10,
  });
  assert.equal(commandExists(process.execPath), true);
  assert.equal(commandExists("definitely-not-an-airo-command"), false);
  assert.match(commandVersion(process.execPath), /^v\d+/);
  assert.match(commandVersion("definitely-not-an-airo-command"), /^ERROR:/);
});

test("keeps Claude progress separate from the terminal result", () => {
  const progress = claudeProgress({
    type: "assistant",
    message: { content: [{ type: "text", text: "Checking the repository." }] },
  });
  const result = claudeProgress({
    type: "result",
    subtype: "success",
    result: "Everything is ready.",
  });

  assert.equal(progress.candidateOutput, "Checking the repository.");
  assert.equal(progress.finalOutput, undefined);
  assert.equal(result.finalOutput, "Everything is ready.");
  assert.equal(result.candidateOutput, undefined);
});

test("normalizes provider token telemetry", () => {
  const claude = claudeProgress({
    type: "result",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      output_tokens: 3,
    },
  });
  const codex = codexProgress({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 7,
      reasoning_output_tokens: 2,
    },
  });

  assert.deepEqual(claude.usage, {
    uncachedInputTokens: 10,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 5,
    outputTokens: 3,
    reasoningOutputTokens: 0,
  });
  assert.deepEqual(codex.usage, {
    uncachedInputTokens: 20,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 0,
    outputTokens: 7,
    reasoningOutputTokens: 2,
  });
});

test("uses the latest completed Codex agent message as the result candidate", () => {
  const first = codexProgress({
    type: "item.completed",
    item: { type: "agent_message", text: "I will inspect the changes." },
  });
  const final = codexProgress({
    type: "item.completed",
    item: { type: "agent_message", text: "Committed successfully." },
  });

  assert.equal(first.candidateOutput, "I will inspect the changes.");
  assert.equal(final.candidateOutput, "Committed successfully.");
});

test("parses Gemini stream messages, tools, errors, and token stats", () => {
  assert.deepEqual(geminiProgress(undefined), { messages: [] });
  assert.match(
    geminiProgress({ type: "init", model: "gemini", session_id: "session" }).messages[0].text,
    /model=gemini session=session/,
  );
  assert.deepEqual(
    geminiProgress({ type: "message", role: "user", content: "prompt" }).candidateOutput,
    undefined,
  );
  const message = geminiProgress({
    type: "message",
    role: "assistant",
    content: "answer",
    delta: true,
  });
  assert.equal(message.candidateOutput, "answer");
  assert.equal(message.appendCandidate, true);
  assert.match(
    geminiProgress({ type: "tool_use", tool_name: "shell", parameters: { command: "pwd" } })
      .messages[0].text,
    /shell/,
  );
  assert.equal(
    geminiProgress({
      type: "tool_result",
      status: "error",
      error: { message: "denied" },
    }).messages[0].category,
    "error",
  );
  assert.equal(
    geminiProgress({ type: "error", severity: "warning", message: "retrying" }).messages[0]
      .category,
    "warning",
  );
  const result = geminiProgress({
    type: "result",
    status: "success",
    stats: { input_tokens: 15, input: 10, cached: 5, output_tokens: 4 },
  });
  assert.deepEqual(result.usage, {
    uncachedInputTokens: 10,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 0,
    outputTokens: 4,
    reasoningOutputTokens: 0,
  });
  assert.equal(
    progressFor("gemini", { type: "message", role: "assistant", content: "done" }).candidateOutput,
    "done",
  );
});

test("returns the complete Gemini streamed answer and usage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-gemini-"));
  const command = path.join(dir, "mock-gemini");
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
for (const content of ["Final ", "result."]) {
  process.stdout.write(JSON.stringify({type:"message", role:"assistant", content, delta:true}) + "\\n");
}
process.stdout.write(JSON.stringify({type:"result", status:"success", stats:{input_tokens:8,input:6,cached:2,output_tokens:3}}) + "\\n");
`,
  );
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.gemini.command = command;
    const route = routeTask("repair parser", config);
    route.agent = "gemini";
    route.model = config.gemini.models.fast.model;
    const logger = new RunLogger({ runId: "gemini", level: "compact", persist: false });
    const run = await runAgent(route, "task", config, {
      headless: true,
      capture: true,
      logger,
      logMeta: {
        phaseIndex: 1,
        phaseTotal: 1,
        phaseKind: "single",
        agent: "gemini",
        model: route.model,
        effort: route.effort,
        tier: route.modelTier,
      },
    });
    assert.equal(run.output, "Final result.");
    assert.equal(run.usage?.cachedInputTokens, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("returns only Claude's result event from a structured run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-"));
  const command = path.join(dir, "mock-claude");
  const assistant = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "I am checking." }] },
  });
  const resultEvent = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Final result only.",
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${assistant}' '${resultEvent}'\n`);
  fs.chmodSync(command, 0o755);

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = command;
    const route = routeTask("investigate architecture", config);
    route.agent = "claude";
    route.modelTier = "balanced";
    route.model = config.claude.models.balanced.model;
    const logger = new RunLogger({ runId: "test", level: "compact", persist: false });
    const run = await runAgent(route, "task", config, {
      headless: true,
      capture: true,
      logger,
      logMeta: {
        phaseIndex: 1,
        phaseTotal: 1,
        phaseKind: "single",
        agent: "claude",
        model: route.model,
        effort: route.effort,
        tier: route.modelTier,
      },
    });

    assert.equal(run.output, "Final result only.");
    assert.equal(run.usage?.outputTokens, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("returns only the latest Codex agent message from a structured run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-"));
  const command = path.join(dir, "mock-codex");
  const first = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "I will inspect first." },
  });
  const final = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Final result only." },
  });
  const completed = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${first}' '${final}' '${completed}'\n`);
  fs.chmodSync(command, 0o755);

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    const route = routeTask("rename this type", config);
    route.agent = "codex";
    route.modelTier = "fast";
    route.model = config.codex.models.fast.model;
    const logger = new RunLogger({ runId: "test", level: "compact", persist: false });
    const run = await runAgent(route, "task", config, {
      headless: true,
      capture: true,
      logger,
      logMeta: {
        phaseIndex: 1,
        phaseTotal: 1,
        phaseKind: "single",
        agent: "codex",
        model: route.model,
        effort: route.effort,
        tier: route.modelTier,
      },
    });

    assert.equal(run.output, "Final result only.");
    assert.equal(run.usage?.outputTokens, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("closes stdin for structured headless providers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-stdin-"));
  const command = path.join(dir, "mock-codex");
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.once("end", () => {
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "stdin closed" }
  }) + "\\n");
});
`,
  );
  fs.chmodSync(command, 0o755);

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    const route = routeTask("check stdin", config);
    route.agent = "codex";
    route.modelTier = "fast";
    route.model = config.codex.models.fast.model;
    const logger = new RunLogger({ runId: "stdin", level: "live", persist: false });
    const run = await runAgent(route, "task", config, {
      headless: true,
      capture: true,
      logger,
      logMeta: {
        phaseIndex: 1,
        phaseTotal: 1,
        phaseKind: "single",
        agent: "codex",
        model: route.model,
        effort: route.effort,
        tier: route.modelTier,
      },
    });

    assert.equal(run.output, "stdin closed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("elevates a Claude run after approval and captures malformed output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-permission-"));
  const command = path.join(dir, "mock-claude");
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
const mode = process.argv[process.argv.indexOf("--permission-mode") + 1];
process.stdout.write("not-json\\n");
process.stdout.write(JSON.stringify({type:"result", subtype:"success", result:mode}) + "\\n");
process.stderr.write("diagnostic\\n");
`,
  );
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = command;
    const route = routeTask("review architecture", config);
    route.agent = "claude";
    route.model = config.claude.models.balanced.model;
    route.modelTier = "balanced";
    const logger = new RunLogger({ runId: "permission", level: "compact", persist: false });
    const run = await runAgent(route, "prompt", config, {
      headless: true,
      capture: true,
      logger,
      elevated: true,
      logMeta: {
        phaseIndex: 1,
        phaseTotal: 1,
        phaseKind: "single",
        agent: "claude",
        model: route.model,
        effort: route.effort,
        tier: route.modelTier,
      },
    });
    assert.equal(run.output, "bypassPermissions");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applies the shared Codex permission policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-codex-permission-"));
  const command = path.join(dir, "mock-codex");
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:process.argv.slice(2).join(" ")}}) + "\\n");
`,
  );
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    const route = routeTask("rename this type", config);
    route.agent = "codex";
    route.model = config.codex.models.fast.model;
    const regular = await runAgent(route, "prompt", config, { headless: true, capture: true });
    assert.match(regular.output, /--sandbox workspace-write/);
    assert.match(regular.output, /sandbox_workspace_write\.network_access=true/);
    assert.match(regular.output, /--ask-for-approval never/);

    const elevated = await runAgent(route, "prompt", config, {
      headless: true,
      capture: true,
      elevated: true,
    });
    assert.match(elevated.output, /--sandbox danger-full-access/);
    assert.match(elevated.output, /--ask-for-approval never/);
    assert.doesNotMatch(elevated.output, /sandbox_workspace_write\.network_access=true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applies the shared Gemini and Copilot permission policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-provider-permission-"));
  const command = path.join(dir, "mock-provider");
  fs.writeFileSync(
    command,
    "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(' '));\n",
  );
  fs.chmodSync(command, 0o755);
  try {
    for (const agent of ["gemini", "copilot"] as const) {
      const config = structuredClone(DEFAULT_CONFIG);
      config[agent].command = command;
      const route = routeTask("repair parser", config);
      route.agent = agent;
      route.model = config[agent].models.fast.model;

      const regular = await runAgent(route, "prompt", config, { headless: true, capture: true });
      if (agent === "gemini") assert.match(regular.output, /--approval-mode default/);
      else assert.match(regular.output, /--allow-all-urls/);
      assert.doesNotMatch(regular.output, /--allow-all(?:\s|$)|--approval-mode yolo/);

      const elevated = await runAgent(route, "prompt", config, {
        headless: true,
        capture: true,
        elevated: true,
      });
      if (agent === "gemini") {
        assert.match(elevated.output, /--approval-mode yolo/);
        assert.match(elevated.output, /--skip-trust/);
      } else {
        assert.match(elevated.output, /--allow-all(?:\s|$)/);
        assert.doesNotMatch(elevated.output, /--allow-all-urls/);
      }

      config.permissions.mode = "fullAccess";
      const fullAccess = await runAgent(route, "prompt", config, {
        headless: true,
        capture: true,
      });
      if (agent === "gemini") assert.match(fullAccess.output, /--approval-mode yolo/);
      else assert.match(fullAccess.output, /--allow-all(?:\s|$)/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only synthesizes a permission question when another access level is available", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-auto-permission-"));
  const command = path.join(dir, "mock-codex");
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:"AIROUTE_QUESTION: GitHub API access is blocked, so I can't open the PR. Please enable network access."}}) + "\\n");
`,
  );
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    const route = routeTask("read API", config);
    route.agent = "codex";

    const regular = await runAgent(route, "prompt", config, { headless: true, capture: true });
    assert.equal(
      regular.question,
      "Permission required to access GitHub and retry the blocked action. Approve?",
    );

    const elevated = await runAgent(route, "prompt", config, {
      headless: true,
      capture: true,
      elevated: true,
    });
    assert.equal(elevated.question, undefined);

    config.permissions.mode = "fullAccess";
    const fullAccess = await runAgent(route, "prompt", config, {
      headless: true,
      capture: true,
    });
    assert.equal(fullAccess.question, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supports unrestricted models with legacy allowlists and plain provider execution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-plain-"));
  const command = path.join(dir, "mock-codex");
  fs.writeFileSync(command, "#!/bin/sh\nprintf plain-output\nprintf diagnostic >&2\nexit 0\n");
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    config.codex.allowedModels = ["gpt-5.6-luna"];
    const route = routeTask("rename type", config);
    route.agent = "codex";
    route.model = "gpt-6-astra";
    route.modelTier = "fast";
    assert.equal(
      (await runAgent(route, "prompt", config, { capture: true })).output,
      "plain-output",
    );
    assert.equal((await runAgent(route, "prompt", config)).exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
