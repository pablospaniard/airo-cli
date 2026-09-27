import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("CLI keeps sync disabled by default and requires an explicit service URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-sync-"));
  const env = {
    ...process.env,
    HOME: path.join(dir, "home"),
    NO_COLOR: "1",
    NODE_V8_COVERAGE: path.join(dir, ".child-coverage"),
  };
  delete env.AIRO_SYNC_URL;
  try {
    const status = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "sync", "status", "--allow-credential-file"],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Status disabled/);
    assert.match(status.stdout, /Account signed out/);
    assert.doesNotMatch(status.stdout, /Server/);

    const login = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "sync", "login", "--allow-credential-file"],
      { cwd: dir, env, encoding: "utf8" },
    );
    assert.equal(login.status, 1);
    assert.match(login.stderr, /Set AIRO_SYNC_URL or pass --server/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
