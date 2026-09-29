import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configCandidates,
  DEFAULT_CONFIG,
  globalConfigPath,
  loadConfig,
  loadGlobalConfig,
  updateGlobalConfig,
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
        history: { enabled: false, path: "data/history.jsonl" },
        logging: { level: "compact" },
        permissions: { networkAccess: false },
        rules: "invalid",
      }),
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.path, path.join(dir, ".airo.json"));
    assert.equal(loaded.config.policy, "claude-heavy");
    assert.equal(loaded.config.modelRouting.mode, "manual");
    assert.equal(loaded.config.claude.models.fast.model, "custom-haiku");
    assert.equal(loaded.config.claude.models.deep.model, DEFAULT_CONFIG.claude.models.deep.model);
    assert.equal(loaded.config.history.enabled, false);
    assert.equal(loaded.config.history.path, path.join(dir, "data", "history.jsonl"));
    assert.equal(loaded.config.permissions.mode, "prompt");
    assert.equal(loaded.config.permissions.networkAccess, false);
    assert.deepEqual(loaded.config.rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizes unknown routing policy and agent values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-invalid-routing-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".airo.json"),
      JSON.stringify({ policy: "gemini-heavy", defaultAgent: "unknown-provider" }),
    );
    const loaded = loadConfig(dir).config;
    assert.equal(loaded.policy, DEFAULT_CONFIG.policy);
    assert.equal(loaded.defaultAgent, DEFAULT_CONFIG.defaultAgent);
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
    assert.equal(JSON.parse(fs.readFileSync(global, "utf8")).modelRouting.mode, "dynamic");
    assert.equal(loadGlobalConfig().path, global);
    assert.equal(loadGlobalConfig().config.modelRouting.mode, "dynamic");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateGlobalConfig mutates the config currently on disk, not a stale snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-update-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    writeGlobalConfig({ ...structuredClone(DEFAULT_CONFIG), policy: "codex-heavy" });
    // Simulate a concurrent editor (e.g. `airo setup`) changing an unrelated
    // field on disk after some other caller last read the config into
    // memory. A mutate callback based on that stale in-memory copy must not
    // be able to clobber this change: updateGlobalConfig always reads fresh.
    writeGlobalConfig({
      ...loadGlobalConfig().config,
      permissions: { mode: "fullAccess", networkAccess: false },
    });

    const result = updateGlobalConfig((current) => ({ ...current, defaultAgent: "gemini" }));
    assert.equal(result.permissions.mode, "fullAccess");
    assert.equal(result.defaultAgent, "gemini");
    assert.equal(loadGlobalConfig().config.permissions.mode, "fullAccess");
    assert.equal(loadGlobalConfig().config.defaultAgent, "gemini");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateGlobalConfig aborts instead of overwriting a save that lands mid-update", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-update-race-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    writeGlobalConfig({ ...structuredClone(DEFAULT_CONFIG), policy: "codex-heavy" });
    assert.throws(
      () =>
        updateGlobalConfig((current) => {
          // Our lock only serializes cooperating callers — an external
          // editor's direct save (simulated here) never takes it, so it can
          // land after `mutate` was handed the config but before the write.
          // updateGlobalConfig must notice and refuse to clobber it.
          writeGlobalConfig({ ...current, policy: "claude-heavy" });
          return { ...current, defaultAgent: "gemini" };
        }),
      /changed on disk/,
    );
    assert.equal(loadGlobalConfig().config.policy, "claude-heavy");
    assert.equal(loadGlobalConfig().config.defaultAgent, "codex");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateGlobalConfig preserves an editor save published during its commit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-config-update-publish-race-"));
  const previousHome = process.env.HOME;
  const originalRename = fs.renameSync;
  process.env.HOME = dir;
  try {
    const file = writeGlobalConfig({ ...structuredClone(DEFAULT_CONFIG), policy: "codex-heavy" });
    let injected = false;
    fs.renameSync = ((oldPath: PathLike, newPath: PathLike) => {
      originalRename(oldPath, newPath);
      if (!injected && oldPath === file && newPath === `${file}.update`) {
        injected = true;
        writeGlobalConfig({ ...structuredClone(DEFAULT_CONFIG), policy: "claude-heavy" });
      }
    }) as typeof fs.renameSync;

    assert.throws(
      () => updateGlobalConfig((current) => ({ ...current, defaultAgent: "gemini" })),
      /changed on disk/,
    );
    assert.equal(injected, true);
    assert.equal(loadGlobalConfig().config.policy, "claude-heavy");
    assert.equal(loadGlobalConfig().config.defaultAgent, "codex");
  } finally {
    fs.renameSync = originalRename;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loads account-wide configuration without repository overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-global-config-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    writeGlobalConfig({ ...structuredClone(DEFAULT_CONFIG), policy: "codex-heavy" });
    fs.writeFileSync(
      path.join(dir, ".airo.json"),
      JSON.stringify({ ...DEFAULT_CONFIG, policy: "claude-heavy" }),
    );
    assert.equal(loadConfig(dir).config.policy, "claude-heavy");
    assert.equal(loadGlobalConfig().config.policy, "codex-heavy");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
