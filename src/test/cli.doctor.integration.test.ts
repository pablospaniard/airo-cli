import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";

test("doctor distinguishes integration support from local command availability", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-doctor-"));
  const home = path.join(dir, "home");

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const agent of ["claude", "codex", "gemini", "copilot"] as const)
      config[agent].command = path.join(dir, `missing-${agent}`);
    const configDir = path.join(home, ".config", "airo");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));

    const env = { ...process.env, HOME: home, NO_COLOR: "1" };
    env.NODE_V8_COVERAGE = path.join(dir, ".child-coverage");
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "doctor"], {
      cwd: dir,
      env,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Provider integration contract v1 ready/);
    assert.equal(result.stdout.match(/integration ready/g)?.length, 4);
    assert.equal(result.stdout.match(/not found in PATH/g)?.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
