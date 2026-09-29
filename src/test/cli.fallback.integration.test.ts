import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";

test("single mode falls back when the automatically selected provider is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-fallback-"));
  const home = path.join(dir, "home");
  const invoked = path.join(dir, "claude-invoked");
  const claude = path.join(dir, "claude");
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes");
console.log(JSON.stringify({type:"result", subtype:"success", result:"Fallback completed."}));
`,
  );
  fs.chmodSync(claude, 0o755);

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = claude;
    config.codex.command = path.join(dir, "missing-codex");
    config.history.enabled = false;
    config.logging.persist = false;
    config.logging.level = "compact";
    const configDir = path.join(home, ".config", "airo");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));

    const env = { ...process.env, HOME: home, NO_COLOR: "1" };
    env.NODE_V8_COVERAGE = path.join(dir, ".child-coverage");
    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "--single", "Rename a type in one file"],
      { cwd: dir, env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(invoked), true);
    assert.match(result.stdout, /codex is not available in PATH.*falling back to claude/);
    assert.match(result.stdout, /Fallback completed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single mode continues when its first fallback also fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-multi-fallback-"));
  const home = path.join(dir, "home");
  const runLog = path.join(dir, "provider-runs");
  const executable = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const codex = executable(
    "codex",
    `require("node:fs").appendFileSync(${JSON.stringify(runLog)}, "codex\\n");
console.log(JSON.stringify({type:"turn.failed",error:{message:"unexpected status 401 Unauthorized: Missing bearer"}}));
process.exit(1);`,
  );
  const claude = executable(
    "claude",
    `if (process.argv.includes("auth")) { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
require("node:fs").appendFileSync(${JSON.stringify(runLog)}, "claude\\n");
console.log(JSON.stringify({type:"result",subtype:"error",result:"Claude usage limit reached."}));
process.exit(1);`,
  );
  const gemini = executable(
    "gemini",
    `require("node:fs").appendFileSync(${JSON.stringify(runLog)}, "gemini\\n");
console.log(JSON.stringify({type:"message",role:"assistant",content:"Fallback completed."}));`,
  );

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = codex;
    config.claude.command = claude;
    config.gemini.command = gemini;
    config.copilot.command = path.join(dir, "missing-copilot");
    config.history.enabled = false;
    config.logging.persist = false;
    config.logging.level = "compact";
    const configDir = path.join(home, ".config", "airo");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));

    const env = { ...process.env, HOME: home, NO_COLOR: "1" };
    env.NODE_V8_COVERAGE = path.join(dir, ".child-coverage");
    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "--single", "Rename a type in one file"],
      { cwd: dir, env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(runLog, "utf8").trim().split("\n"), [
      "codex",
      "claude",
      "gemini",
    ]);
    assert.match(result.stdout, /codex authentication failure.*falling back to claude/s);
    assert.match(result.stdout, /claude usage limit failure.*falling back to gemini/s);
    assert.match(result.stdout, /Fallback completed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
