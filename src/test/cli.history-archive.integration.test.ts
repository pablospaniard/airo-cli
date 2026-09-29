import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import type { HistoryRecord } from "../types.js";

test("CLI exports and idempotently imports encrypted learning evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-archive-"));
  const home = path.join(dir, "home");
  const history = path.join(dir, "history.jsonl");
  const archive = path.join(dir, "learning.airo");
  const config = structuredClone(DEFAULT_CONFIG);
  config.history.path = history;
  const record: HistoryRecord = {
    id: "portable-phase",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    task: "portable task",
    agent: "codex",
    modelTier: "fast",
    model: "model",
    effort: "low",
    complexity: 1,
    exitCode: 0,
    durationMs: 1,
  };
  try {
    const configDir = path.join(home, ".config", "airo");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
    fs.writeFileSync(history, `${JSON.stringify(record)}\n`);
    const env = {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      AIRO_ARCHIVE_PASSPHRASE: "portable integration passphrase",
      NODE_V8_COVERAGE: path.join(dir, ".child-coverage"),
    };

    const exported = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "history", "export", "--encrypted", archive],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /encrypted archive written/);
    fs.unlinkSync(history);

    const imported = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "history", "import", archive],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /1 imported · 0 already present · 1 total/);

    const repeated = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "history", "import", archive],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /0 imported · 1 already present · 1 total/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
