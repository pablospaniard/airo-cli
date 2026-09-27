import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeGlobalConfig } from "./config.js";
import { dataRootDir } from "./paths.js";
import { feedbackPath, historyPath, readFeedback, readHistory } from "./history.js";
import { jevFeedbackPath, readJevFeedback } from "./jev-feedback.js";
import type { FeedbackRecord, HistoryRecord, RouterConfig } from "./types.js";
import {
  createAccountKey,
  decryptSyncPayload,
  encodeAccountKey,
  encryptSyncPayload,
  syncRepositoryId,
  unwrapAccountKey,
  wrapAccountKey,
  type SyncEnvelope,
  type WrappedAccountKey,
} from "./sync-crypto.js";

interface Credentials {
  accessToken: string;
  refreshToken: string;
  accountKey?: string;
}

interface SyncState {
  version: 1;
  server: string;
  deviceId: string;
  enabled: boolean;
  cursor: number;
  user?: { id: string; login: string };
  settingsRevision?: number;
  settingsDigest?: string;
  lastSyncAt?: string;
}

interface SyncEvent {
  cursor?: number;
  id: string;
  kind: "history" | "feedback" | "jev-feedback" | "tombstone";
  repositoryId?: string;
  createdAt: number;
  envelope: SyncEnvelope;
}

class SyncApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function retryTransientFetch(
  request: () => Promise<Response>,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

export interface CredentialStore {
  load(): Credentials | undefined;
  save(value: Credentials): void;
  clear(): void;
  description: string;
}

function restrictedWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function syncStatePath(root = dataRootDir()): string {
  return path.join(root, "sync.json");
}

export function syncPassphrase(args: string[]): {
  value: string;
  source: "argument" | "file" | "environment";
} {
  const passphraseIndex = args.indexOf("--passphrase");
  if (passphraseIndex >= 0) {
    const value = args[passphraseIndex + 1];
    if (!value || value.startsWith("--")) throw new Error("--passphrase requires a value.");
    return { value, source: "argument" };
  }
  const passphraseFileIndex = args.indexOf("--passphrase-file");
  if (passphraseFileIndex >= 0) {
    const file = args[passphraseFileIndex + 1];
    if (!file) throw new Error("--passphrase-file requires a path.");
    return {
      value: fs.readFileSync(path.resolve(file), "utf8").replace(/[\r\n]+$/, ""),
      source: "file",
    };
  }
  const passphrase = process.env.AIRO_SYNC_PASSPHRASE;
  if (!passphrase)
    throw new Error("Use --passphrase, set AIRO_SYNC_PASSPHRASE, or use --passphrase-file.");
  return { value: passphrase, source: "environment" };
}

function readState(root = dataRootDir()): SyncState | undefined {
  const file = syncStatePath(root);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
}

function writeState(state: SyncState, root = dataRootDir()): void {
  restrictedWrite(syncStatePath(root), state);
}

function commandAvailable(command: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory: string) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

class MacCredentialStore implements CredentialStore {
  description = "macOS Keychain";
  constructor(private account: string) {}
  load(): Credentials | undefined {
    try {
      return JSON.parse(
        execFileSync(
          "security",
          ["find-generic-password", "-s", "airo-sync", "-a", this.account, "-w"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ),
      ) as Credentials;
    } catch {
      return undefined;
    }
  }
  save(value: Credentials): void {
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-s",
      "airo-sync",
      "-a",
      this.account,
      "-w",
      JSON.stringify(value),
    ]);
  }
  clear(): void {
    try {
      execFileSync("security", ["delete-generic-password", "-s", "airo-sync", "-a", this.account], {
        stdio: "ignore",
      });
    } catch {}
  }
}

class SecretToolStore implements CredentialStore {
  description = "Secret Service keyring";
  load(): Credentials | undefined {
    try {
      return JSON.parse(
        execFileSync("secret-tool", ["lookup", "application", "airo", "service", "sync"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ) as Credentials;
    } catch {
      return undefined;
    }
  }
  save(value: Credentials): void {
    execFileSync(
      "secret-tool",
      ["store", "--label=AIRO sync", "application", "airo", "service", "sync"],
      {
        input: JSON.stringify(value),
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
  }
  clear(): void {
    try {
      execFileSync("secret-tool", ["clear", "application", "airo", "service", "sync"], {
        stdio: "ignore",
      });
    } catch {}
  }
}

class FileCredentialStore implements CredentialStore {
  description = "permission-restricted local file";
  constructor(private file: string) {}
  load(): Credentials | undefined {
    return fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as Credentials)
      : undefined;
  }
  save(value: Credentials): void {
    restrictedWrite(this.file, value);
  }
  clear(): void {
    try {
      fs.unlinkSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function credentialStore(allowFile = false, root = dataRootDir()): CredentialStore {
  if (allowFile) return new FileCredentialStore(path.join(root, "sync-credentials.json"));
  if (process.platform === "darwin" && commandAvailable("security"))
    return new MacCredentialStore(os.userInfo().username);
  if (process.platform === "linux" && commandAvailable("secret-tool")) return new SecretToolStore();
  throw new Error(
    "No supported operating-system credential store was found. Re-run with --allow-credential-file to explicitly use a mode-0600 local file.",
  );
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function safeSyncSettings(config: RouterConfig): Record<string, unknown> {
  const providerModels = Object.fromEntries(
    (["claude", "codex", "gemini", "copilot"] as const).map((provider) => [
      provider,
      { models: config[provider].models, defaultModel: config[provider].defaultModel },
    ]),
  );
  return {
    policy: config.policy,
    defaultAgent: config.defaultAgent,
    history: {
      learningEnabled: config.history.learningEnabled,
      similarityThreshold: config.history.similarityThreshold,
      minimumSamples: config.history.minimumSamples,
      halfLifeDays: config.history.halfLifeDays,
      explorationRate: config.history.explorationRate,
      repositoryScoped: config.history.repositoryScoped,
    },
    orchestration: config.orchestration,
    rules: config.rules,
    providers: providerModels,
  };
}

function applySafeSettings(config: RouterConfig, value: Record<string, unknown>): RouterConfig {
  const providers = value.providers as
    | Record<string, { models?: RouterConfig["claude"]["models"]; defaultModel?: string }>
    | undefined;
  const history = (value.history ?? {}) as Partial<RouterConfig["history"]>;
  const orchestration = (value.orchestration ?? {}) as Partial<RouterConfig["orchestration"]>;
  return {
    ...config,
    ...(typeof value.policy === "string" ? { policy: value.policy as RouterConfig["policy"] } : {}),
    ...(typeof value.defaultAgent === "string"
      ? { defaultAgent: value.defaultAgent as RouterConfig["defaultAgent"] }
      : {}),
    history: {
      ...config.history,
      ...history,
      path: config.history.path,
      enabled: config.history.enabled,
    },
    orchestration: { ...config.orchestration, ...orchestration },
    rules: Array.isArray(value.rules) ? (value.rules as RouterConfig["rules"]) : config.rules,
    claude: {
      ...config.claude,
      ...providers?.claude,
      models: providers?.claude?.models ?? config.claude.models,
    },
    codex: {
      ...config.codex,
      ...providers?.codex,
      models: providers?.codex?.models ?? config.codex.models,
    },
    gemini: {
      ...config.gemini,
      ...providers?.gemini,
      models: providers?.gemini?.models ?? config.gemini.models,
    },
    copilot: {
      ...config.copilot,
      ...providers?.copilot,
      models: providers?.copilot?.models ?? config.copilot.models,
    },
  };
}

async function api<T>(
  state: SyncState,
  route: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const request = () =>
    fetch(`${state.server}${route}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  const retryable = (init.method ?? "GET").toUpperCase() === "GET" || route === "/v1/auth/github";
  const response = retryable ? await retryTransientFetch(request) : await request();
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok)
    throw new SyncApiError(
      body.error?.message ?? `Sync service returned HTTP ${response.status}.`,
      response.status,
      (body.error as { code?: string } | undefined)?.code,
    );
  return body;
}

async function authenticated<T>(
  state: SyncState,
  store: CredentialStore,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  let credentials = store.load();
  if (!credentials) throw new Error("This device is not signed in. Run `airo sync login`.");
  try {
    return await api<T>(state, route, init, credentials.accessToken);
  } catch (error) {
    if (!(error instanceof SyncApiError) || error.status !== 401) throw error;
    const refreshed = await api<{ accessToken: string; refreshToken: string }>(
      state,
      "/v1/auth/refresh",
      {
        method: "POST",
        body: JSON.stringify({ refreshToken: credentials.refreshToken }),
      },
    ).catch(() => undefined);
    if (!refreshed) throw error;
    credentials = { ...credentials, ...refreshed };
    store.save(credentials);
    return api<T>(state, route, init, credentials.accessToken);
  }
}

export async function syncLogin(options: {
  server?: string;
  allowCredentialFile?: boolean;
  onChallenge: (verificationUri: string, userCode: string) => void;
}): Promise<{ login: string; credentialStore: string }> {
  const root = dataRootDir();
  const existing = readState(root);
  const server = options.server ?? process.env.AIRO_SYNC_URL ?? existing?.server;
  if (!server)
    throw new Error("Set AIRO_SYNC_URL or pass --server with the deployed AIRO sync Worker URL.");
  const state: SyncState = existing ?? {
    version: 1,
    server: server.replace(/\/$/, ""),
    deviceId: crypto.randomUUID(),
    enabled: false,
    cursor: 0,
  };
  if (options.server) state.server = options.server.replace(/\/$/, "");
  const store = credentialStore(options.allowCredentialFile, root);
  const authConfig = await api<{ provider: "github"; clientId: string }>(state, "/v1/auth/config");
  const githubResponse = await retryTransientFetch(() =>
    fetch("https://github.com/login/device/code", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "airo-cli",
      },
      body: new URLSearchParams({ client_id: authConfig.clientId, scope: "read:user" }),
    }),
  );
  const started = (await githubResponse.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  };
  if (
    !githubResponse.ok ||
    !started.device_code ||
    !started.user_code ||
    !started.verification_uri ||
    !started.expires_in ||
    !started.interval
  )
    throw new Error(
      `GitHub device authorization failed (${started.error ?? githubResponse.status}).`,
    );
  options.onChallenge(started.verification_uri, started.user_code);
  const deadline = Date.now() + started.expires_in * 1000;
  let delay = started.interval;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    let response: Response;
    try {
      response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "airo-cli",
        },
        body: new URLSearchParams({
          client_id: authConfig.clientId,
          device_code: started.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch {
      // A temporary GitHub/network failure must not invalidate an otherwise
      // active device challenge. The next poll can safely continue it.
      continue;
    }
    const result = (await response.json()) as {
      access_token?: string;
      error?: string;
    };
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      delay += 5;
      continue;
    }
    if (!response.ok || !result.access_token)
      throw new Error(`GitHub device authorization failed (${result.error ?? response.status}).`);
    const authorized = await api<{
      accessToken: string;
      refreshToken: string;
      user: { id: string; login: string };
    }>(state, "/v1/auth/github", {
      method: "POST",
      body: JSON.stringify({
        deviceId: state.deviceId,
        deviceName: os.hostname().slice(0, 80),
        githubAccessToken: result.access_token,
      }),
    });
    store.save({ accessToken: authorized.accessToken, refreshToken: authorized.refreshToken });
    state.user = authorized.user;
    writeState(state, root);
    return { login: authorized.user.login, credentialStore: store.description };
  }
  throw new Error("Device authorization expired.");
}

export async function enableSync(passphrase: string, allowFile = false): Promise<void> {
  const state = readState();
  if (!state?.user) throw new Error("Run `airo sync login` first.");
  const store = credentialStore(allowFile);
  const credentials = store.load();
  if (!credentials) throw new Error("Sync credentials are missing. Run `airo sync login` again.");
  let key: Buffer;
  try {
    const remote = await authenticated<{ envelope: WrappedAccountKey }>(
      state,
      store,
      "/v1/account-key",
    );
    key = unwrapAccountKey(remote.envelope, passphrase);
  } catch (error) {
    if (
      !(error instanceof SyncApiError) ||
      error.status !== 404 ||
      error.code !== "account_key_missing"
    )
      throw error;
    key = createAccountKey();
    await authenticated(state, store, "/v1/account-key", {
      method: "PUT",
      body: JSON.stringify({ envelope: wrapAccountKey(key, passphrase) }),
    });
  }
  store.save({ ...credentials, accountKey: encodeAccountKey(key) });
  state.enabled = true;
  writeState(state);
}

function eventContext(event: Pick<SyncEvent, "id" | "kind">): string {
  return `event:${event.kind}:${event.id}`;
}

function localEvents(config: RouterConfig, key: Buffer): SyncEvent[] {
  const make = (
    kind: SyncEvent["kind"],
    record: { id: string; timestamp?: string; repositoryId?: string },
  ): SyncEvent => ({
    id: record.id,
    kind,
    repositoryId: record.repositoryId ? syncRepositoryId(key, record.repositoryId) : undefined,
    createdAt: Math.floor(new Date(record.timestamp ?? 0).getTime() / 1000) || 0,
    envelope: encryptSyncPayload(key, record, `event:${kind}:${record.id}`),
  });
  return [
    ...readHistory(config.history).map((record) => make("history", record)),
    ...readFeedback(config.history).map((record) => make("feedback", record)),
    ...readJevFeedback(config.history).map((record) => make("jev-feedback", record)),
  ];
}

function mergeJsonLines<T extends { id: string }>(file: string, incoming: T[]): number {
  const current: T[] = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line: string) => {
          try {
            return [JSON.parse(line) as T];
          } catch {
            return [];
          }
        })
    : [];
  const byId = new Map(current.map((record) => [record.id, record]));
  let added = 0;
  for (const record of incoming) {
    const existing = byId.get(record.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record))
      throw new Error(`Sync conflict: immutable record ${record.id} has different content.`);
    if (!existing) {
      byId.set(record.id, record);
      added++;
    }
  }
  if (added) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      [...byId.values()].map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  }
  return added;
}

export async function syncNow(
  config: RouterConfig,
  allowFile = false,
): Promise<{ pushed: number; pulled: number }> {
  const state = readState();
  if (!state?.enabled) throw new Error("Sync is disabled. Run `airo sync enable`.");
  const store = credentialStore(allowFile);
  const credentials = store.load();
  if (!credentials?.accountKey)
    throw new Error("The local account key is missing. Run `airo sync enable`.");
  const key = Buffer.from(credentials.accountKey, "base64url");
  const events = localEvents(config, key);
  let pushed = 0;
  for (let index = 0; index < events.length; index += 100) {
    const result = await authenticated<{ accepted: number }>(state, store, "/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ events: events.slice(index, index + 100) }),
    });
    pushed += result.accepted;
  }
  const incoming: Record<SyncEvent["kind"], Array<{ id: string }>> = {
    history: [],
    feedback: [],
    "jev-feedback": [],
    tombstone: [],
  };
  let hasMore = true;
  while (hasMore) {
    const result = await authenticated<{ events: SyncEvent[]; cursor: number; hasMore: boolean }>(
      state,
      store,
      `/v1/sync/pull?cursor=${state.cursor}&limit=100`,
    );
    for (const event of result.events) {
      if (event.kind === "tombstone") continue;
      const record = decryptSyncPayload<{ id: string }>(key, event.envelope, eventContext(event));
      if (record.id !== event.id)
        throw new Error(`Sync event ${event.id} failed identity validation.`);
      incoming[event.kind].push(record);
    }
    state.cursor = result.cursor;
    hasMore = result.hasMore;
  }
  let pulled = 0;
  pulled += mergeJsonLines(historyPath(config.history), incoming.history as HistoryRecord[]);
  pulled += mergeJsonLines(feedbackPath(config.history), incoming.feedback as FeedbackRecord[]);
  pulled += mergeJsonLines(jevFeedbackPath(config.history), incoming["jev-feedback"]);

  const localSettings = safeSyncSettings(config);
  const localDigest = digest(localSettings);
  const remote = await authenticated<{
    settings: Array<{ key: string; revision: number; envelope: SyncEnvelope }>;
  }>(state, store, "/v1/settings");
  const routing = remote.settings.find((item) => item.key === "routing");
  if (!routing) {
    const saved = await authenticated<{ revision: number }>(state, store, "/v1/settings", {
      method: "PUT",
      body: JSON.stringify({
        key: "routing",
        expectedRevision: 0,
        envelope: encryptSyncPayload(key, localSettings, "setting:routing"),
      }),
    });
    state.settingsRevision = saved.revision;
    state.settingsDigest = localDigest;
  } else {
    const remoteSettings = decryptSyncPayload<Record<string, unknown>>(
      key,
      routing.envelope,
      "setting:routing",
    );
    const remoteDigest = digest(remoteSettings);
    const localChanged = state.settingsDigest !== undefined && state.settingsDigest !== localDigest;
    const remoteChanged =
      state.settingsRevision !== undefined && state.settingsRevision !== routing.revision;
    if (localChanged && remoteChanged && localDigest !== remoteDigest)
      throw new Error(
        "Synced routing settings changed both locally and remotely; no settings were overwritten.",
      );
    if (localChanged && localDigest !== remoteDigest) {
      const saved = await authenticated<{ revision: number }>(state, store, "/v1/settings", {
        method: "PUT",
        body: JSON.stringify({
          key: "routing",
          expectedRevision: routing.revision,
          envelope: encryptSyncPayload(key, localSettings, "setting:routing"),
        }),
      });
      state.settingsRevision = saved.revision;
      state.settingsDigest = localDigest;
    } else {
      if (localDigest !== remoteDigest)
        writeGlobalConfig(applySafeSettings(config, remoteSettings));
      state.settingsRevision = routing.revision;
      state.settingsDigest = remoteDigest;
    }
  }
  state.lastSyncAt = new Date().toISOString();
  writeState(state);
  return { pushed, pulled };
}

export function syncStatus(allowFile = false): {
  state?: SyncState;
  credentials: boolean;
  credentialStore?: string;
} {
  const state = readState();
  try {
    const store = credentialStore(allowFile);
    return { state, credentials: Boolean(store.load()), credentialStore: store.description };
  } catch {
    return { state, credentials: false };
  }
}

export async function syncDevices(
  allowFile = false,
): Promise<Array<{ id: string; name: string; lastSeenAt: number; current: boolean }>> {
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  return (
    await authenticated<{
      devices: Array<{ id: string; name: string; lastSeenAt: number; current: boolean }>;
    }>(state, credentialStore(allowFile), "/v1/devices")
  ).devices;
}

export async function syncRevokeDevice(deviceId: string, allowFile = false): Promise<void> {
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(deviceId)) throw new Error("Invalid device ID.");
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  await authenticated(state, credentialStore(allowFile), `/v1/devices/${deviceId}`, {
    method: "DELETE",
  });
}

export async function exportCloudData(
  output: string,
  options: { allowFile?: boolean; overwrite?: boolean } = {},
): Promise<string> {
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  const file = path.resolve(output);
  if (fs.existsSync(file) && !options.overwrite)
    throw new Error(`${file} already exists. Use --force to replace it.`);
  const data = await authenticated<Record<string, unknown>>(
    state,
    credentialStore(options.allowFile),
    "/v1/account/export",
  );
  restrictedWrite(file, data);
  return file;
}

export async function syncLogout(allowFile = false): Promise<void> {
  const state = readState();
  if (!state) return;
  const store = credentialStore(allowFile);
  await authenticated(state, store, "/v1/auth/logout", { method: "POST" }).catch(() => undefined);
  store.clear();
  state.enabled = false;
  state.user = undefined;
  writeState(state);
}

export async function deleteCloudData(allowFile = false): Promise<void> {
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  const store = credentialStore(allowFile);
  await authenticated(state, store, "/v1/account", {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  store.clear();
  try {
    fs.unlinkSync(syncStatePath());
  } catch {}
}
