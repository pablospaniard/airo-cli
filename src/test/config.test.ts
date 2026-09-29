import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configCandidates,
  DEFAULT_CONFIG,
  globalConfigPath,
  loadConfig,
  writeGlobalConfig,
  writeProjectConfig,
} from "../config.js";

test("prefers AIRO project config while retaining the legacy filename", () => {
  const cwd = path.resolve("fixture-project");
  const candidates = configCandidates(cwd);

  assert.equal(candidates[0], path.join(cwd, ".airo.json"));
  assert.equal(candidates[1], path.join(cwd, ".ai-router.json"));
  assert.match(candidates[2], /[\\/]\.config[\\/]airo[\\/]config\.json$/);
  assert.match(candidates[3], /[\\/]\.config[\\/]ai-router[\\/]config\.json$/);
});

test("loads and deeply merges project configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".airo.json"),
      JSON.stringify({
        policy: "claude-heavy",
        claude: { models: { fast: { model: "custom-haiku" } } },
        history: { enabled: false },
        logging: { level: "compact" },
        permissions: { networkAccess: false },
        rules: "invalid",
      }),
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.path, path.join(dir, ".airo.json"));
    assert.equal(loaded.config.policy, "claude-heavy");
    assert.equal(loaded.config.claude.models.fast.model, "custom-haiku");
    assert.equal(loaded.config.claude.models.deep.model, DEFAULT_CONFIG.claude.models.deep.model);
    assert.equal(loaded.config.history.enabled, false);
    assert.equal(loaded.config.permissions.mode, "prompt");
    assert.equal(loaded.config.permissions.networkAccess, false);
    assert.deepEqual(loaded.config.rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizes invalid routing policy, agent, and custom rule fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-invalid-routing-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".airo.json"),
      JSON.stringify({
        policy: "gemini-heavy",
        defaultAgent: "unknown-provider",
        rules: [
          {
            name: "stale rule",
            pattern: "review",
            agent: "clude",
            modelTier: "enormous",
            effort: "extreme",
          },
          { name: 42, pattern: "ignored" },
        ],
      }),
    );

    const loaded = loadConfig(dir).config;
    assert.equal(loaded.policy, DEFAULT_CONFIG.policy);
    assert.equal(loaded.defaultAgent, DEFAULT_CONFIG.defaultAgent);
    assert.deepEqual(loaded.rules, [{ name: "stale rule", pattern: "review" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writes project and global configuration safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-write-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    assert.deepEqual(loadConfig(path.join(dir, "missing")), { config: DEFAULT_CONFIG });
    const project = writeProjectConfig(dir);
    assert.equal(JSON.parse(fs.readFileSync(project, "utf8")).policy, "balanced");
    assert.throws(() => writeProjectConfig(dir), /already exists/);

    const global = writeGlobalConfig(DEFAULT_CONFIG);
    assert.equal(global, globalConfigPath());
    assert.equal(JSON.parse(fs.readFileSync(global, "utf8")).defaultAgent, "codex");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
