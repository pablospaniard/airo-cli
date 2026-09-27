import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, writeGlobalConfig } from "../config.js";
import {
  credentialStore,
  enableSync,
  safeSyncSettings,
  syncNow,
  syncPassphrase,
  syncStatePath,
} from "../sync.js";
import {
  createAccountKey,
  decryptSyncPayload,
  encodeAccountKey,
  encryptSyncPayload,
  wrapAccountKey,
  type SyncEnvelope,
} from "../sync-crypto.js";

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
  assert.deepEqual(settings.modelRouting, { mode: "dynamic" });
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

test("sync setup accepts an explicit recovery passphrase string", () => {
  assert.deepEqual(syncPassphrase(["sync", "enable", "--passphrase", "long recovery phrase"]), {
    value: "long recovery phrase",
    source: "argument",
  });
  assert.throws(
    () => syncPassphrase(["sync", "enable", "--passphrase"]),
    /--passphrase requires a value/,
  );
});

test("sync enable preserves tokens rotated while loading the account key", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-enable-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: false,
      cursor: 0,
      user: { id: "user-test", login: "tester" },
    }),
  );
  const store = credentialStore(true, root);
  store.save({ accessToken: "old-access", refreshToken: "old-refresh" });
  const passphrase = "a sufficiently long recovery phrase";
  const accountKey = createAccountKey();
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/v1/auth/refresh"))
        return Response.json({ accessToken: "new-access", refreshToken: "new-refresh" });
      if (url.endsWith("/v1/account-key") && authorization === "Bearer old-access")
        return Response.json(
          { error: { code: "unauthorized", message: "expired" } },
          { status: 401 },
        );
      if (url.endsWith("/v1/account-key") && authorization === "Bearer new-access")
        return Response.json({ envelope: wrapAccountKey(accountKey, passphrase) });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await enableSync(passphrase, true);
    assert.deepEqual(store.load(), {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accountKey: encodeAccountKey(accountKey),
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync uses global settings and applies the newest version of a changed record", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-global-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      user: { id: "user-test", login: "tester" },
    }),
  );
  const accountKey = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(accountKey),
  });
  const globalConfig = structuredClone(DEFAULT_CONFIG);
  globalConfig.policy = "codex-heavy";
  writeGlobalConfig(globalConfig);
  const projectConfig = structuredClone(DEFAULT_CONFIG);
  projectConfig.policy = "claude-heavy";
  projectConfig.permissions.mode = "fullAccess";
  projectConfig.history.path = historyFile;
  const original = {
    id: "1234567890abcdef1234567890abcdef",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    task: "original",
    agent: "codex",
    modelTier: "balanced",
    model: "model",
    effort: "medium",
    complexity: 1,
    exitCode: 0,
    durationMs: 1,
  } as const;
  const updated = { ...original, task: "updated remotely" };
  fs.writeFileSync(historyFile, `${JSON.stringify(original)}\n`);
  let pushedVersion = "";
  let settingsEnvelope: SyncEnvelope | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ version: string }> };
        pushedVersion = body.events[0].version;
        return Response.json({ accepted: 1 });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({
          events: [
            {
              id: updated.id,
              version: "r".repeat(43),
              kind: "history",
              createdAt: 1,
              envelope: encryptSyncPayload(accountKey, updated, `event:history:${updated.id}`),
            },
          ],
          cursor: 1,
          hasMore: false,
        });
      if (url.pathname === "/v1/settings" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { envelope: SyncEnvelope };
        settingsEnvelope = body.envelope;
        return Response.json({ revision: 1 });
      }
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    const result = await syncNow(projectConfig, true);
    assert.deepEqual(result, { pushed: 1, pulled: 1 });
    assert.match(pushedVersion, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(JSON.parse(fs.readFileSync(historyFile, "utf8")).task, "updated remotely");
    assert.ok(settingsEnvelope);
    const settings = decryptSyncPayload<{ policy: string }>(
      accountKey,
      settingsEnvelope,
      "setting:routing",
    );
    assert.equal(settings.policy, "codex-heavy");
    assert.doesNotMatch(JSON.stringify(settings), /fullAccess/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(
  "macOS Keychain writes credentials through stdin instead of process arguments",
  { skip: process.platform !== "darwin" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-keychain-"));
    const argsFile = path.join(dir, "args.json");
    const inputFile = path.join(dir, "input.txt");
    const command = path.join(dir, "security");
    const previousPath = process.env.PATH;
    const previousArgs = process.env.AIRO_TEST_SECURITY_ARGS;
    const previousInput = process.env.AIRO_TEST_SECURITY_INPUT;
    fs.writeFileSync(
      command,
      `#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.AIRO_TEST_SECURITY_ARGS,JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.env.AIRO_TEST_SECURITY_INPUT,fs.readFileSync(0,"utf8"));`,
    );
    fs.chmodSync(command, 0o755);
    process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
    process.env.AIRO_TEST_SECURITY_ARGS = argsFile;
    process.env.AIRO_TEST_SECURITY_INPUT = inputFile;
    try {
      credentialStore(false, dir).save({
        accessToken: "secret-access",
        refreshToken: "secret-refresh",
        accountKey: "raw-encryption-key",
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["-i"]);
      const input = fs.readFileSync(inputFile, "utf8");
      assert.doesNotMatch(input, /secret-access|secret-refresh|raw-encryption-key/);
      assert.match(input, /^add-generic-password /);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousArgs === undefined) delete process.env.AIRO_TEST_SECURITY_ARGS;
      else process.env.AIRO_TEST_SECURITY_ARGS = previousArgs;
      if (previousInput === undefined) delete process.env.AIRO_TEST_SECURITY_INPUT;
      else process.env.AIRO_TEST_SECURITY_INPUT = previousInput;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
