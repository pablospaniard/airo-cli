import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runCli(dir: string, home: string, args: string[]): ReturnType<typeof spawnSync> {
  const env = { ...process.env, HOME: home, NO_COLOR: "1" };
  env.NODE_V8_COVERAGE = path.join(dir, ".child-coverage");
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
}

test("airo help prints the same full command reference as airo --help", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-help-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });

  try {
    const bareHelp = runCli(dir, home, ["help"]);
    const dashHelp = runCli(dir, home, ["--help"]);

    assert.equal(bareHelp.status, 0, bareHelp.stderr);
    assert.equal(dashHelp.status, 0, dashHelp.stderr);
    assert.equal(bareHelp.stdout, dashHelp.stdout);
    assert.match(bareHelp.stdout, /airo usage cost \[period\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
