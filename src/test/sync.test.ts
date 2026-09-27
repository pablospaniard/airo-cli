import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { credentialStore, safeSyncSettings } from "../sync.js";

test("sync settings exclude secrets and machine-specific configuration", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.codex.command = "/private/bin/codex";
  config.codex.args = ["--secret", "value"];
  config.permissions.mode = "fullAccess";
  config.permissions.networkAccess = false;
  config.history.path = "/private/history.jsonl";

  const settings = safeSyncSettings(config);
  const serialized = JSON.stringify(settings);
  assert.doesNotMatch(serialized, /private\/bin|--secret|private\/history|fullAccess/);
  assert.equal((settings as { policy: string }).policy, config.policy);
  assert.deepEqual(
    (settings.providers as { codex: { models: unknown } }).codex.models,
    config.codex.models,
  );
});

test("credential-file fallback requires an explicit choice and restrictive permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-store-"));
  try {
    const store = credentialStore(true, root);
    store.save({ accessToken: "access", refreshToken: "refresh" });
    assert.deepEqual(store.load(), { accessToken: "access", refreshToken: "refresh" });
    assert.equal(fs.statSync(path.join(root, "sync-credentials.json")).mode & 0o777, 0o600);
    store.clear();
    assert.equal(store.load(), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
