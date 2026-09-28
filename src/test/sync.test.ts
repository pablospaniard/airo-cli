import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadGlobalConfig, writeGlobalConfig } from "../config.js";
import { appendHistory, setScopedFeedback } from "../history.js";
import {
  applySafeSettings,
  credentialStore,
  enableSync,
  exportCloudData,
  safeSyncSettings,
  syncDevices,
  syncLogin,
  syncNow,
  syncPassphrase,
  syncStatePath,
  syncStatus,
} from "../sync.js";
import {
  createAccountKey,
  decryptSyncPayload,
  encodeAccountKey,
  encryptSyncPayload,
  wrapAccountKey,
  type SyncEnvelope,
} from "../sync-crypto.js";
import { readSyncDeletions, recordSyncDeletions } from "../sync-deletions.js";

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(file) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(file), true, `Timed out waiting for ${file}`);
}

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

test("applying pulled settings does not resurrect a field another device removed", () => {
  const local = structuredClone(DEFAULT_CONFIG);
  local.codex.defaultModel = "gpt-5.6-terra";

  // The remote snapshot has no `defaultModel` for codex at all — as if
  // another device cleared it and safeSyncSettings dropped the now-undefined
  // key when it serialized to JSON for the PUT body.
  const remote = safeSyncSettings(DEFAULT_CONFIG);
  delete (remote.providers as { codex: { defaultModel?: string } }).codex.defaultModel;

  const applied = applySafeSettings(local, remote);
  assert.equal(applied.codex.defaultModel, undefined);
});

test("applying pulled settings keeps machine-local fields sync never carries", () => {
  const local = structuredClone(DEFAULT_CONFIG);
  local.codex.command = "/opt/homebrew/bin/codex";
  local.history.path = "/private/history.jsonl";
  local.history.enabled = false;

  const remote = safeSyncSettings(DEFAULT_CONFIG);
  const applied = applySafeSettings(local, remote);
  assert.equal(applied.codex.command, "/opt/homebrew/bin/codex");
  assert.equal(applied.history.path, "/private/history.jsonl");
  assert.equal(applied.history.enabled, false);
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

test("sync login resets a changed account namespace and remembers file credentials", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-login-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://old-sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 99,
      user: { id: "old-user", login: "old" },
      settingsRevision: 7,
      settingsDigest: "old-digest",
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      records: { history: { "old-record": "v".repeat(43) } },
    }),
  );
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/auth/config")
        return Response.json({ provider: "github", clientId: "client-test" });
      if (url.hostname === "github.com" && url.pathname === "/login/device/code")
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 60,
          interval: 0.001,
        });
      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token")
        return Response.json({ access_token: "github-access-token-value" });
      if (url.pathname === "/v1/auth/github")
        return Response.json({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          user: { id: "new-user", login: "new" },
        });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await syncLogin({
      server: "https://new-sync.test",
      allowCredentialFile: true,
      onChallenge: () => {},
    });
    const state = JSON.parse(fs.readFileSync(syncStatePath(root), "utf8"));
    assert.equal(state.cursor, 0);
    assert.equal(state.settingsRevision, undefined);
    assert.equal(state.settingsDigest, undefined);
    assert.equal(state.lastSyncAt, undefined);
    assert.equal(state.records, undefined);
    assert.equal(state.enabled, false);
    assert.deepEqual(state.syncIdentity, {
      server: "https://new-sync.test",
      userId: "new-user",
    });
    assert.equal(state.credentialStore, "file");
    assert.equal(credentialStore(true, root).load()?.accountKey, undefined);
    assert.equal(syncStatus().credentials, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync login preserves the account key when reauthenticating the same account", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-relogin-"));
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
      enabled: true,
      cursor: 12,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
      syncIdentity: { server: "https://sync.test", userId: "user-test" },
    }),
  );
  const store = credentialStore(true, root);
  store.save({ accessToken: "old-access", refreshToken: "old-refresh", accountKey: "account-key" });
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/auth/config")
        return Response.json({ provider: "github", clientId: "client-test" });
      if (url.hostname === "github.com" && url.pathname === "/login/device/code")
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 60,
          interval: 0.001,
        });
      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token")
        return Response.json({ access_token: "github-access-token-value" });
      if (url.pathname === "/v1/auth/github")
        return Response.json({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          user: { id: "user-test", login: "tester" },
        });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await syncLogin({ server: "https://sync.test", onChallenge: () => {} });
    assert.deepEqual(store.load(), {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accountKey: "account-key",
    });
    assert.equal(JSON.parse(fs.readFileSync(syncStatePath(root), "utf8")).cursor, 12);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
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

test("concurrent authenticated requests rotate an expired refresh token only once", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-refresh-lock-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({ accessToken: "old-access", refreshToken: "old-refresh" });
  let refreshes = 0;
  let retriedRequests = 0;
  let bothRetriedBeforeRelease = false;
  let releaseRetries!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetries = resolve;
  });
  const retryTimer = setTimeout(releaseRetries, 250);
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/v1/devices" && authorization === "Bearer old-access")
        return Response.json({ error: { message: "expired" } }, { status: 401 });
      if (url.pathname === "/v1/auth/refresh") {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json({ accessToken: "new-access", refreshToken: "new-refresh" });
      }
      if (url.pathname === "/v1/devices" && authorization === "Bearer new-access") {
        retriedRequests++;
        if (retriedRequests === 2) {
          bothRetriedBeforeRelease = true;
          releaseRetries();
        }
        await retryGate;
        return Response.json({ devices: [] });
      }
      throw new Error(`Unexpected sync request: ${url}`);
    };

    assert.deepEqual(await Promise.all([syncDevices(), syncDevices()]), [[], []]);
    assert.equal(refreshes, 1);
    assert.equal(bothRetriedBeforeRelease, true);
  } finally {
    clearTimeout(retryTimer);
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent sync operations are serialized around shared state", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-operation-lock-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(createAccountKey()),
  });
  let pullCalls = 0;
  let secondEnteredBeforeRelease = false;
  let firstReleased = false;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const timer = setTimeout(() => {
    firstReleased = true;
    releaseFirst();
  }, 150);
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/pull") {
        pullCalls++;
        if (pullCalls === 1) await firstGate;
        else if (pullCalls === 2 && !firstReleased) secondEnteredBeforeRelease = true;
        return Response.json({ events: [], cursor: 0, hasMore: false });
      }
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await Promise.all([
      syncNow(structuredClone(DEFAULT_CONFIG)),
      syncNow(structuredClone(DEFAULT_CONFIG)),
    ]);
    assert.equal(pullCalls, 2);
    assert.equal(secondEnteredBeforeRelease, false);
  } finally {
    clearTimeout(timer);
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("login cannot switch accounts during an active sync", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-account-lock-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "account-a", login: "account-a" },
      syncIdentity: { server: "https://sync.test", userId: "account-a" },
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-a",
    refreshToken: "refresh-a",
    accountKey: encodeAccountKey(createAccountKey()),
  });
  let releaseSync!: () => void;
  let syncEntered!: () => void;
  const syncGate = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    syncEntered = resolve;
  });
  let accountRequestBeforeRelease = false;
  let released = false;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/pull") {
        syncEntered();
        await syncGate;
        return Response.json({ events: [], cursor: 0, hasMore: false });
      }
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      if (url.pathname === "/v1/auth/config") {
        if (!released) accountRequestBeforeRelease = true;
        return Response.json({ provider: "github", clientId: "client-test" });
      }
      if (url.hostname === "github.com" && url.pathname === "/login/device/code")
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 60,
          interval: 0.001,
        });
      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token")
        return Response.json({ access_token: "github-token" });
      if (url.pathname === "/v1/auth/github")
        return Response.json({
          accessToken: "access-b",
          refreshToken: "refresh-b",
          user: { id: "account-b", login: "account-b" },
        });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    const syncing = syncNow(structuredClone(DEFAULT_CONFIG));
    await entered;
    const loggingIn = syncLogin({ server: "https://sync.test", onChallenge: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(accountRequestBeforeRelease, false);
    released = true;
    releaseSync();
    await Promise.all([syncing, loggingIn]);
    assert.equal(accountRequestBeforeRelease, false);
    assert.equal(syncStatus().state?.user?.id, "account-b");
  } finally {
    releaseSync();
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

test("sync normalizes unknown routing values received from another device", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-invalid-routing-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  writeGlobalConfig({
    ...structuredClone(DEFAULT_CONFIG),
    policy: "codex-heavy",
    defaultAgent: "gemini",
  });
  const remote = encryptSyncPayload(
    key,
    { ...safeSyncSettings(DEFAULT_CONFIG), policy: "gemini-heavy", defaultAgent: "other" },
    "setting:routing",
  );
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings")
        return Response.json({ settings: [{ key: "routing", revision: 1, envelope: remote }] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await syncNow(structuredClone(DEFAULT_CONFIG));
    const saved = loadGlobalConfig().config;
    assert.equal(saved.policy, DEFAULT_CONFIG.policy);
    assert.equal(saved.defaultAgent, DEFAULT_CONFIG.defaultAgent);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync records always use the global history dataset", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-canonical-history-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const record = { id: "canonical-history-record", timestamp: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(historyFile, `${JSON.stringify(record)}\n`);
  const key = createAccountKey();
  const version = crypto
    .createHmac("sha256", key)
    .update(JSON.stringify(record))
    .digest("base64url");
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
      records: { history: { [record.id]: version } },
      recordsPath: historyFile,
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const projectConfig = structuredClone(DEFAULT_CONFIG);
  projectConfig.history.enabled = false;
  projectConfig.history.path = path.join(home, "different-project-history.jsonl");
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push")
        throw new Error("The project-local view must not create a tombstone.");
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    assert.deepEqual(await syncNow(projectConfig), { pushed: 0, pulled: 0 });
    assert.equal(fs.readFileSync(historyFile, "utf8"), `${JSON.stringify(record)}\n`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync batches pushes by bytes and emits tombstones for deleted records", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-batches-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const deletedId = "deleted-feedback-record";
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
      records: { feedback: { [deletedId]: "d".repeat(43) } },
      recordsPath: historyFile,
    }),
  );
  const largeOutput = "x".repeat(350_000);
  fs.writeFileSync(
    historyFile,
    [0, 1, 2]
      .map((index) =>
        JSON.stringify({
          id: `large-history-record-${index}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/repo",
          task: `task ${index}`,
          agent: "codex",
          modelTier: "balanced",
          model: "model",
          effort: "medium",
          complexity: 1,
          exitCode: 0,
          durationMs: 1,
          outputExcerpt: largeOutput,
        }),
      )
      .join("\n") + "\n",
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.history.path = historyFile;
  recordSyncDeletions(historyFile, "feedback", [deletedId]);
  const requestSizes: number[] = [];
  const pushed: Array<{ id: string; kind: string; envelope: SyncEnvelope }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = String(init?.body);
        requestSizes.push(Buffer.byteLength(body));
        const parsed = JSON.parse(body) as { events: typeof pushed };
        assert.ok(parsed.events.length <= 100);
        pushed.push(...parsed.events);
        return Response.json({ accepted: parsed.events.length });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await syncNow(config);
    assert.ok(requestSizes.length > 1);
    assert.ok(requestSizes.every((size) => size <= 900_000));
    const tombstone = pushed.find((event) => event.kind === "tombstone");
    assert.ok(tombstone);
    assert.deepEqual(decryptSyncPayload(key, tombstone.envelope, `event:tombstone:${deletedId}`), {
      id: deletedId,
      targetKind: "feedback",
      deletedVersion: "d".repeat(43),
    });
    assert.deepEqual(readSyncDeletions(historyFile), []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync never infers deletions from a missing or malformed history source", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-source-safety-"));
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
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
      records: { history: { "existing-record": "v".repeat(43) } },
      recordsPath: historyFile,
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(createAccountKey()),
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.history.path = historyFile;
  let pushes = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        pushes++;
        return Response.json({ accepted: 0 });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    assert.equal((await syncNow(config)).pushed, 0);
    assert.equal(pushes, 0);

    fs.writeFileSync(historyFile, '{"id":"broken"\n');
    await assert.rejects(syncNow(config), /contains invalid JSON/);
    assert.equal(pushes, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync retries HTML server errors and reports structured results", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-http-retry-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(createAccountKey()),
  });
  let pulls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/pull") {
        pulls++;
        if (pulls < 3)
          return new Response("<html>temporary outage</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          });
        return Response.json({ events: [], cursor: 0, hasMore: false });
      }
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    assert.deepEqual(await syncNow(structuredClone(DEFAULT_CONFIG)), { pushed: 0, pulled: 0 });
    assert.equal(pulls, 3);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync sends only changes and gives every delete or restore a unique version", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-transitions-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const record = { id: "restored-history-record", timestamp: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(historyFile, `${JSON.stringify(record)}\n`);
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const config = structuredClone(DEFAULT_CONFIG);
  const pushed: Array<{ id: string; version: string; kind: string }> = [];
  let settings: SyncEnvelope | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = JSON.parse(String(init?.body)) as { events: typeof pushed };
        pushed.push(...body.events);
        return Response.json({ accepted: body.events.length });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings" && init?.method === "PUT") {
        settings = (JSON.parse(String(init.body)) as { envelope: SyncEnvelope }).envelope;
        return Response.json({ revision: 1 });
      }
      if (url.pathname === "/v1/settings")
        return Response.json({
          settings: settings ? [{ key: "routing", revision: 1, envelope: settings }] : [],
        });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    assert.equal((await syncNow(config)).pushed, 1);
    assert.equal((await syncNow(config)).pushed, 0);
    fs.unlinkSync(historyFile);
    recordSyncDeletions(historyFile, "history", [record.id]);
    assert.equal((await syncNow(config)).pushed, 1);
    fs.writeFileSync(historyFile, `${JSON.stringify(record)}\n`);
    assert.equal((await syncNow(config)).pushed, 1);
    fs.unlinkSync(historyFile);
    recordSyncDeletions(historyFile, "history", [record.id]);
    assert.equal((await syncNow(config)).pushed, 1);

    assert.deepEqual(
      pushed.map((event) => event.kind),
      ["history", "tombstone", "history", "tombstone"],
    );
    assert.equal(new Set(pushed.map((event) => event.version)).size, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync retries a failed push with the same durable operation version", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-pending-push-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "history.jsonl"),
    `${JSON.stringify({ id: "pending-history-record" })}\n`,
  );
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const versions: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ version: string }> };
        versions.push(body.events[0].version);
        if (versions.length === 1) throw new Error("connection dropped");
        return Response.json({ accepted: body.events.length });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await assert.rejects(syncNow(structuredClone(DEFAULT_CONFIG)), /connection dropped/);
    assert.equal((await syncNow(structuredClone(DEFAULT_CONFIG))).pushed, 1);
    assert.deepEqual(versions, [versions[0], versions[0]]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync persists only one size-bounded push batch after a failure", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-bounded-pending-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  fs.mkdirSync(root, { recursive: true });
  const records = Array.from({ length: 140 }, (_, index) => ({
    id: `bounded-history-${index}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    task: "x".repeat(10_000),
  }));
  fs.writeFileSync(
    path.join(root, "history.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(createAccountKey()),
  });
  try {
    globalThis.fetch = async (input) => {
      if (new URL(String(input)).pathname === "/v1/sync/push")
        throw new Error("simulated connection loss");
      throw new Error(`Unexpected sync request: ${input}`);
    };
    await assert.rejects(syncNow(structuredClone(DEFAULT_CONFIG)), /simulated connection loss/);
    const serialized = fs.readFileSync(syncStatePath(root), "utf8");
    const saved = JSON.parse(serialized) as { pendingEvents: unknown[] };
    assert.ok(saved.pendingEvents.length > 0);
    assert.ok(saved.pendingEvents.length < records.length);
    assert.ok(Buffer.byteLength(JSON.stringify({ events: saved.pendingEvents })) <= 900_000);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync applies all pull pages atomically and persists the final cursor", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-tombstone-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const id = "history-record-to-delete";
  fs.writeFileSync(historyFile, `${JSON.stringify({ id, task: "delete me" })}\n`);
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.history.path = historyFile;
  const tombstonePayload = {
    id,
    targetKind: "history",
    deletedVersion: crypto
      .createHmac("sha256", key)
      .update(JSON.stringify({ id, task: "delete me" }))
      .digest("base64url"),
  };
  let pulls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return Response.json({ accepted: body.events.length });
      }
      if (url.pathname === "/v1/sync/pull") {
        pulls++;
        if (pulls === 1)
          return Response.json({
            events: [
              {
                id,
                version: "t".repeat(43),
                kind: "tombstone",
                createdAt: 1,
                envelope: encryptSyncPayload(key, tombstonePayload, `event:tombstone:${id}`),
              },
            ],
            cursor: 4,
            hasMore: true,
          });
        const saved = JSON.parse(fs.readFileSync(syncStatePath(root), "utf8"));
        assert.equal(saved.cursor, 0);
        assert.match(fs.readFileSync(historyFile, "utf8"), new RegExp(id));
        return Response.json({ events: [], cursor: 4, hasMore: false });
      }
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    const result = await syncNow(config);
    assert.equal(result.pulled, 1);
    assert.equal(pulls, 2);
    assert.equal(JSON.parse(fs.readFileSync(syncStatePath(root), "utf8")).cursor, 4);
    assert.equal(fs.readFileSync(historyFile, "utf8"), "");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync ignores a stale tombstone after a newer remote edit", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-stale-tombstone-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const original = { id: "concurrently-edited-history", task: "original" };
  const remoteEdit = { ...original, task: "newer remote edit" };
  fs.writeFileSync(historyFile, `${JSON.stringify(original)}\n`);
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const originalVersion = crypto
    .createHmac("sha256", key)
    .update(JSON.stringify(original))
    .digest("base64url");
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return Response.json({ accepted: body.events.length });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({
          events: [
            {
              id: original.id,
              version: "e".repeat(43),
              kind: "history",
              createdAt: 2,
              envelope: encryptSyncPayload(key, remoteEdit, `event:history:${original.id}`),
            },
            {
              id: original.id,
              version: "t".repeat(43),
              kind: "tombstone",
              createdAt: 3,
              envelope: encryptSyncPayload(
                key,
                { id: original.id, targetKind: "history", deletedVersion: originalVersion },
                `event:tombstone:${original.id}`,
              ),
            },
          ],
          cursor: 2,
          hasMore: false,
        });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    const result = await syncNow(structuredClone(DEFAULT_CONFIG));
    assert.equal(result.pulled, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, "utf8")), remoteEdit);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync pull preserves a history record appended by another process", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-concurrent-write-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  const readyFile = path.join(root, "writer-ready");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(historyFile, `${JSON.stringify({ id: "existing-record" })}\n`);
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  const key = createAccountKey();
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const remote = { id: "remote-record", timestamp: "2026-01-01T00:00:00.000Z" };
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("node:fs");const lock=${JSON.stringify(`${historyFile}.lock`)};fs.writeFileSync(lock,process.pid+"\\nchild\\n",{flag:"wx"});fs.writeFileSync(${JSON.stringify(readyFile)},"ready");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(historyFile)},JSON.stringify({id:"concurrent-record"})+"\\n");fs.unlinkSync(lock)},100);`,
    ],
    { stdio: "ignore" },
  );
  try {
    while (!fs.existsSync(readyFile)) await new Promise((resolve) => setTimeout(resolve, 5));
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return Response.json({ accepted: body.events.length });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({
          events: [
            {
              id: remote.id,
              version: "r".repeat(43),
              kind: "history",
              createdAt: 1,
              envelope: encryptSyncPayload(key, remote, `event:history:${remote.id}`),
            },
          ],
          cursor: 1,
          hasMore: false,
        });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await syncNow(structuredClone(DEFAULT_CONFIG));
    const ids = fs
      .readFileSync(historyFile, "utf8")
      .trim()
      .split("\n")
      .map((line: string) => (JSON.parse(line) as { id: string }).id)
      .sort();
    assert.deepEqual(ids, ["concurrent-record", "existing-record", "remote-record"]);
  } finally {
    child.kill();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync waits for a consistent history snapshot before emitting tombstones", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-snapshot-lock-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  const readyFile = path.join(root, "rewrite-ready");
  fs.mkdirSync(root, { recursive: true });
  const record = { id: "record-being-rewritten", timestamp: "2026-01-01T00:00:00.000Z" };
  const serialized = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(historyFile, serialized);
  const key = createAccountKey();
  const version = crypto
    .createHmac("sha256", key)
    .update(JSON.stringify(record))
    .digest("base64url");
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
      records: { history: { [record.id]: version } },
      recordsPath: historyFile,
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("node:fs");const lock=${JSON.stringify(`${historyFile}.lock`)};fs.writeFileSync(lock,process.pid+"\\nlegacy\\n",{flag:"wx"});fs.writeFileSync(${JSON.stringify(historyFile)},"");fs.writeFileSync(${JSON.stringify(readyFile)},"ready");setTimeout(()=>{fs.writeFileSync(${JSON.stringify(historyFile)},${JSON.stringify(serialized)});fs.unlinkSync(lock)},100);`,
    ],
    { stdio: "ignore" },
  );
  let pushes = 0;
  try {
    await waitForFile(readyFile);
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        pushes++;
        return Response.json({ accepted: 1 });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({ events: [], cursor: 0, hasMore: false });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };
    await syncNow(structuredClone(DEFAULT_CONFIG));
    assert.equal(pushes, 0);
    assert.equal(fs.readFileSync(historyFile, "utf8"), serialized);
  } finally {
    child.kill();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync pull preserves and later pushes a same-record concurrent edit or restore", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-same-record-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  const historyFile = path.join(root, "history.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const original = { id: "same-record", timestamp: "2026-01-01T00:00:00.000Z", task: "original" };
  const localEdit = { ...original, task: "local edit" };
  const remoteEdit = { ...original, task: "remote edit" };
  fs.writeFileSync(historyFile, `${JSON.stringify(original)}\n`);
  const key = createAccountKey();
  const version = crypto
    .createHmac("sha256", key)
    .update(JSON.stringify(original))
    .digest("base64url");
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
      records: { history: { [original.id]: version } },
      recordsPath: historyFile,
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  let pulls = 0;
  const pushedTasks: string[] = [];
  const pushedKinds: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const events = (
          JSON.parse(String(init?.body)) as { events: Array<{ envelope: SyncEnvelope }> }
        ).events as Array<{ kind: string; envelope: SyncEnvelope }>;
        for (const event of events) {
          pushedKinds.push(event.kind);
          if (event.kind === "history")
            pushedTasks.push(
              decryptSyncPayload<{ task?: string }>(
                key,
                event.envelope,
                `event:history:${original.id}`,
              ).task ?? "",
            );
        }
        return Response.json({ accepted: events.length });
      }
      if (url.pathname === "/v1/sync/pull") {
        pulls++;
        if (pulls === 1) {
          fs.writeFileSync(historyFile, `${JSON.stringify(localEdit)}\n`);
          return Response.json({
            events: [
              {
                id: original.id,
                version: "r".repeat(43),
                kind: "history",
                createdAt: 1,
                envelope: encryptSyncPayload(key, remoteEdit, `event:history:${original.id}`),
              },
            ],
            cursor: 1,
            hasMore: false,
          });
        }
        if (pulls === 3) {
          fs.writeFileSync(historyFile, `${JSON.stringify(localEdit)}\n`);
          const tombstone = {
            id: original.id,
            targetKind: "history",
            deletedVersion: "d".repeat(43),
          };
          return Response.json({
            events: [
              {
                id: original.id,
                version: "t".repeat(43),
                kind: "tombstone",
                createdAt: 2,
                envelope: encryptSyncPayload(key, tombstone, `event:tombstone:${original.id}`),
              },
            ],
            cursor: 2,
            hasMore: false,
          });
        }
        return Response.json({ events: [], cursor: pulls >= 3 ? 2 : 1, hasMore: false });
      }
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };

    await syncNow(structuredClone(DEFAULT_CONFIG));
    assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, "utf8")), localEdit);
    await syncNow(structuredClone(DEFAULT_CONFIG));
    assert.deepEqual(pushedTasks, ["local edit"]);
    fs.unlinkSync(historyFile);
    recordSyncDeletions(historyFile, "history", [original.id]);
    await syncNow(structuredClone(DEFAULT_CONFIG));
    assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, "utf8")), localEdit);
    await syncNow(structuredClone(DEFAULT_CONFIG));
    assert.deepEqual(pushedKinds, ["history", "tombstone", "history"]);
    assert.deepEqual(pushedTasks, ["local edit", "local edit"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("feedback without an explicit target stays on the latest local run after pull", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-local-feedback-"));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = home;
  const root = path.join(home, ".local", "share", "airo");
  fs.mkdirSync(root, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const local = {
    id: "local-phase",
    runId: "local-run",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: home,
    task: "local task",
    agent: "codex" as const,
    modelTier: "balanced" as const,
    model: "model",
    effort: "medium" as const,
    complexity: 1,
    exitCode: 0,
    durationMs: 1,
  };
  appendHistory(config.history, local);
  const remote = {
    ...local,
    id: "remote-phase",
    runId: "remote-run",
    timestamp: "2099-01-01T00:00:00.000Z",
  };
  const key = createAccountKey();
  fs.writeFileSync(
    syncStatePath(root),
    JSON.stringify({
      version: 1,
      server: "https://sync.test",
      deviceId: "device-test",
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountKey: encodeAccountKey(key),
  });
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/sync/push") {
        const events = (JSON.parse(String(init?.body)) as { events: unknown[] }).events;
        return Response.json({ accepted: events.length });
      }
      if (url.pathname === "/v1/sync/pull")
        return Response.json({
          events: [
            {
              id: remote.id,
              version: "r".repeat(43),
              kind: "history",
              createdAt: 1,
              envelope: encryptSyncPayload(key, remote, `event:history:${remote.id}`),
            },
          ],
          cursor: 1,
          hasMore: false,
        });
      if (url.pathname === "/v1/settings" && init?.method === "PUT")
        return Response.json({ revision: 1 });
      if (url.pathname === "/v1/settings") return Response.json({ settings: [] });
      throw new Error(`Unexpected sync request: ${url}`);
    };
    await syncNow(config);
    assert.equal(setScopedFeedback(config.history, "good").targetId, "local-run");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cloud export follows every bounded event page", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-export-pages-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({ accessToken: "access-token", refreshToken: "refresh-token" });
  const output = path.join(home, "account-export.json");
  let pages = 0;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/account/export") throw new Error(`Unexpected request: ${url}`);
      assert.equal(url.searchParams.get("paged"), "1");
      pages++;
      return pages === 1
        ? Response.json({
            schemaVersion: 1,
            user: { id: "user-test" },
            devices: [{ id: "device-1" }],
            settings: [{ key: "routing" }],
            accountKey: null,
            events: [{ cursor: 1 }],
            eventCursor: 1,
            deviceOffset: 1,
            settingOffset: 1,
            hasMore: true,
          })
        : Response.json({
            schemaVersion: 1,
            user: { id: "user-test" },
            devices: [{ id: "device-2" }],
            settings: [{ key: "other" }],
            accountKey: null,
            events: [{ cursor: 2 }],
            eventCursor: 2,
            deviceOffset: 2,
            settingOffset: 2,
            hasMore: false,
          });
    };

    await exportCloudData(output);
    const exported = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(exported.events, [{ cursor: 1 }, { cursor: 2 }]);
    assert.deepEqual(exported.devices, [{ id: "device-1" }, { id: "device-2" }]);
    assert.deepEqual(exported.settings, [{ key: "routing" }, { key: "other" }]);
    assert.equal(exported.hasMore, undefined);
    assert.equal(exported.eventCursor, undefined);

    const completedExport = fs.readFileSync(output, "utf8");
    globalThis.fetch = async () =>
      Response.json({
        schemaVersion: 1,
        user: { id: "user-test" },
        devices: [],
        settings: [],
        accountKey: null,
        events: [],
        eventCursor: 0,
        deviceOffset: 0,
        settingOffset: 0,
        hasMore: true,
      });
    await assert.rejects(
      exportCloudData(output, { overwrite: true }),
      /did not advance any collection cursor/,
    );
    assert.equal(fs.readFileSync(output, "utf8"), completedExport);
    assert.deepEqual(
      fs.readdirSync(home).filter((entry: string) => entry.startsWith(".airo-export-")),
      [],
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cloud export and device operations share the account-operation lock", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-sync-export-lock-"));
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
      enabled: true,
      cursor: 0,
      credentialStore: "file",
      user: { id: "user-test", login: "tester" },
    }),
  );
  credentialStore(true, root).save({ accessToken: "access-token", refreshToken: "refresh-token" });
  const output = path.join(home, "account-export.json");
  let releaseExport!: () => void;
  let markExportStarted!: () => void;
  const exportGate = new Promise<void>((resolve) => (releaseExport = resolve));
  const exportStarted = new Promise<void>((resolve) => (markExportStarted = resolve));
  let devicesRequested = false;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/account/export") {
        markExportStarted();
        await exportGate;
        return Response.json({
          schemaVersion: 1,
          user: { id: "user-test" },
          devices: [],
          settings: [],
          accountKey: null,
          events: [],
          eventCursor: 0,
          deviceOffset: 0,
          settingOffset: 0,
          hasMore: false,
        });
      }
      if (url.pathname === "/v1/devices") {
        devicesRequested = true;
        return Response.json({ devices: [] });
      }
      throw new Error(`Unexpected sync request: ${url}`);
    };

    const exporting = exportCloudData(output);
    await exportStarted;
    const listing = syncDevices();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(devicesRequested, false);
    releaseExport();
    await Promise.all([exporting, listing]);
    assert.equal(devicesRequested, true);
  } finally {
    releaseExport();
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
