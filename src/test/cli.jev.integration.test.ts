import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";

test("CLI exposes explicit Jev consent, status, disable, inspect, and reset controls", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-jev-"));
  const home = path.join(directory, "home");
  const configDirectory = path.join(home, ".config", "airo");
  const history = path.join(directory, "history.jsonl");
  const cli = path.resolve("dist/cli.js");
  try {
    fs.mkdirSync(configDirectory, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.history.path = history;
    config.logging.persist = false;
    fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify(config));
    const env = {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      NODE_V8_COVERAGE: path.join(directory, ".child-coverage"),
    };
    delete env.TYPESAFE_API_KEY;
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: directory,
        env,
        encoding: "utf8",
      });

    const rejected = run("feedback", "jev", "enable");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Consent was not recorded/);

    const enabled = run("feedback", "jev", "enable", "--accept-data-sharing");
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /Jev feedback enabled/);
    assert.doesNotMatch(
      fs.readFileSync(history.replace(/\.jsonl$/, ".jev-consent.json"), "utf8"),
      /API_KEY/,
    );

    const status = run("feedback", "jev", "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /enabled/);
    assert.match(status.stdout, /not set/);

    const inspect = run("feedback", "jev", "inspect");
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.match(inspect.stdout, /No Jev feedback yet/);

    const resetRejected = run("feedback", "jev", "reset");
    assert.notEqual(resetRejected.status, 0);
    assert.match(resetRejected.stderr, /reset --yes/);
    assert.equal(run("feedback", "jev", "reset", "--yes").status, 0);
    assert.equal(run("feedback", "jev", "disable").status, 0);
    assert.match(run("feedback", "jev", "status").stdout, /disabled/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
