import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectDefaultModels, inspectAccounts } from "../account.js";
import { DEFAULT_CONFIG } from "../config.js";

test("explicit AIRO default-model overrides are deterministic", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.claude.defaultModel = "fable";
  config.codex.defaultModel = "gpt-default";
  config.gemini.defaultModel = "gemini-default";
  config.copilot.defaultModel = "copilot-default";

  assert.deepEqual(detectDefaultModels(config, "/missing"), {
    claude: "fable",
    codex: "gpt-default",
    gemini: "gemini-default",
    copilot: "copilot-default",
  });
});

test("detects layered provider defaults and authenticated accounts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-account-"));
  const repo = path.join(home, "repo");
  const codexHome = path.join(home, "codex-home");
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ model: "home-model" }),
  );
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "bad json");
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.local.json"),
    JSON.stringify({ model: "local-model" }),
  );
  fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "codex-model"\n`);
  const claude = path.join(home, "claude");
  const codex = path.join(home, "codex");
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nprintf '{"loggedIn":true,"emailAddress":"user@example.com","authMethod":"oauth"}'\n`,
  );
  fs.writeFileSync(codex, "#!/bin/sh\nprintf 'Logged in using ChatGPT'\n");
  fs.chmodSync(claude, 0o755);
  fs.chmodSync(codex, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    delete config.claude.defaultModel;
    delete config.codex.defaultModel;
    config.claude.command = claude;
    config.codex.command = codex;
    assert.deepEqual(detectDefaultModels(config, repo), {
      claude: "local-model",
      codex: "codex-model",
      gemini: undefined,
      copilot: undefined,
    });
    const accounts = inspectAccounts(config, repo);
    assert.deepEqual(
      accounts.slice(0, 2).map((account) => account.authenticated),
      [true, true],
    );
    assert.deepEqual(
      accounts.slice(2).map((account) => account.authenticated),
      [undefined, undefined],
    );
    assert.match(accounts[2].status, /authentication not inspected|not found in PATH/);
    assert.equal(accounts[0].identity, "user@example.com");
    assert.equal(accounts[1].authMethod, "ChatGPT");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("does not read a negated sign-in message as an authenticated account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-account-negated-"));
  const claude = path.join(dir, "claude");
  const codex = path.join(dir, "codex");
  fs.writeFileSync(claude, "#!/bin/sh\nprintf 'You are not logged in'\n");
  fs.writeFileSync(codex, "#!/bin/sh\nprintf 'Not logged in'\n");
  fs.chmodSync(claude, 0o755);
  fs.chmodSync(codex, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = claude;
    config.codex.command = codex;
    const accounts = inspectAccounts(config, dir);
    assert.deepEqual(
      accounts.slice(0, 2).map((account) => account.authenticated),
      [false, false],
    );
    assert.equal(accounts[1].status, "Not logged in");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reports unavailable and unauthenticated providers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-account-status-"));
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, "#!/bin/sh\nprintf 'signed out'\nexit 1\n");
  fs.chmodSync(claude, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = claude;
    config.codex.command = path.join(dir, "missing");
    const accounts = inspectAccounts(config, dir);
    assert.equal(accounts[0].available, true);
    assert.equal(accounts[0].authenticated, false);
    assert.equal(accounts[1].available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
