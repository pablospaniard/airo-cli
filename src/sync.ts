import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadGlobalConfig, writeGlobalConfig } from "./config.js";
import { dataRootDir } from "./paths.js";
import { feedbackPath, historyPath, readFeedback, readHistory } from "./history.js";
import { jevFeedbackPath, readJevFeedback } from "./jev-feedback.js";
import { withFileLock, withFileLockAsync, withFileLocks } from "./file-lock.js";
import type { RouterConfig } from "./types.js";
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

type SyncDataKind = "history" | "feedback" | "jev-feedback";
type SyncRecordManifest = Partial<Record<SyncDataKind, Record<string, string>>>;

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
  credentialStore?: "system" | "file";
  syncIdentity?: { server: string; userId: string };
  records?: SyncRecordManifest;
  recordsPath?: string;
  pendingEvents?: SyncEvent[];
  pendingRecords?: SyncRecordManifest;
  pendingRecordsPath?: string;
}

interface SyncEvent {
  cursor?: number;
  id: string;
  version: string;
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
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    const descriptor = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function appendJsonItems(file: string, items: unknown[], alreadyHasItems: boolean): boolean {
  if (!items.length) return alreadyHasItems;
  const serialized = items.map((item) => JSON.stringify(item)).join(",");
  fs.appendFileSync(file, `${alreadyHasItems ? "," : ""}${serialized}`, { mode: 0o600 });
  return true;
}

function writeAll(descriptor: number, value: string | Buffer): void {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  let offset = 0;
  while (offset < buffer.length)
    offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
}

function copyFileToDescriptor(source: string, destination: number): void {
  const sourceDescriptor = fs.openSync(source, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null)) > 0)
      writeAll(destination, buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(sourceDescriptor);
  }
}

function writeCloudExport(
  file: string,
  metadata: Record<string, unknown>,
  collections: Array<{ key: string; spool: string }>,
): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  let closed = false;
  try {
    const entries = Object.entries(metadata).map(
      ([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`,
    );
    writeAll(descriptor, `{${entries.length ? `${entries.join(",")},` : ""}`);
    collections.forEach(({ key, spool }, index) => {
      writeAll(descriptor, `${JSON.stringify(key)}:[`);
      copyFileToDescriptor(spool, descriptor);
      writeAll(descriptor, `]${index + 1 < collections.length ? "," : ""}`);
    });
    writeAll(descriptor, "}\n");
    fs.fsyncSync(descriptor);
    closed = true;
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (!closed) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
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
      const stored = execFileSync(
        "security",
        ["find-generic-password", "-s", "airo-sync", "-a", this.account, "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      try {
        // Compatibility with credentials written before stdin-safe storage.
        return JSON.parse(stored) as Credentials;
      } catch {
        return JSON.parse(Buffer.from(stored, "base64url").toString("utf8")) as Credentials;
      }
    } catch {
      return undefined;
    }
  }
  save(value: Credentials): void {
    if (!/^[a-zA-Z0-9_.@+-]{1,128}$/.test(this.account))
      throw new Error("The macOS account name cannot be passed safely to Keychain.");
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    execFileSync("security", ["-i"], {
      input: `add-generic-password -U -s airo-sync -a ${this.account} -w ${encoded}\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
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

function credentialStoreForState(
  state: SyncState | undefined,
  allowFile = false,
  root = dataRootDir(),
): CredentialStore {
  return credentialStore(allowFile || state?.credentialStore === "file", root);
}

function resetSyncProgress(state: SyncState): void {
  state.cursor = 0;
  delete state.settingsRevision;
  delete state.settingsDigest;
  delete state.lastSyncAt;
  delete state.records;
  delete state.recordsPath;
  delete state.pendingEvents;
  delete state.pendingRecords;
  delete state.pendingRecordsPath;
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
    modelRouting: config.modelRouting,
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
    modelRouting: ["dynamic", "manual"].includes(
      String((value.modelRouting as { mode?: unknown } | undefined)?.mode),
    )
      ? (value.modelRouting as RouterConfig["modelRouting"])
      : config.modelRouting,
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = retryable ? await retryTransientFetch(request) : await request();
    const body = (await response.json()) as T & { error?: { message?: string } };
    if (response.ok) return body;
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(250 * 2 ** attempt, retryAfter * 1000)),
      );
      continue;
    }
    throw new SyncApiError(
      body.error?.message ?? `Sync service returned HTTP ${response.status}.`,
      response.status,
      (body.error as { code?: string } | undefined)?.code,
    );
  }
  throw new Error("Sync request retries were exhausted.");
}

async function authenticated<T>(
  state: SyncState,
  store: CredentialStore,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  let credentials = store.load();
  if (!credentials) throw new Error("This device is not signed in. Run `airo sync login`.");
  const attemptedAccessToken = credentials.accessToken;
  try {
    return await api<T>(state, route, init, credentials.accessToken);
  } catch (error) {
    if (!(error instanceof SyncApiError) || error.status !== 401) throw error;
    const refreshedCredentials = await withFileLockAsync(
      path.join(dataRootDir(), "sync-refresh.lock"),
      async () => {
        const current = store.load();
        if (!current) throw error;
        if (current.accessToken !== attemptedAccessToken) {
          return current;
        }
        const refreshed = await api<{ accessToken: string; refreshToken: string }>(
          state,
          "/v1/auth/refresh",
          {
            method: "POST",
            body: JSON.stringify({ refreshToken: current.refreshToken }),
          },
        ).catch(() => undefined);
        if (!refreshed) throw error;
        credentials = { ...current, ...refreshed };
        store.save(credentials);
        return credentials;
      },
    );
    // Do not hold the refresh lock during the retried application request.
    // Other processes only need serialization while rotating and persisting
    // the one-time refresh token.
    return api<T>(state, route, init, refreshedCredentials.accessToken);
  }
}

function withSyncOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  return withFileLockAsync(path.join(dataRootDir(), "sync-operation.lock"), operation, {
    timeoutMs: 15 * 60_000,
  });
}

async function syncLoginUnlocked(options: {
  server?: string;
  allowCredentialFile?: boolean;
  onChallenge: (verificationUri: string, userCode: string) => void;
}): Promise<{ login: string; credentialStore: string }> {
  const root = dataRootDir();
  const existing = readState(root);
  const previousServer = existing?.server;
  const useCredentialFile = Boolean(
    options.allowCredentialFile || existing?.credentialStore === "file",
  );
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
  state.server = server.replace(/\/$/, "");
  const previousIdentity =
    state.syncIdentity ??
    (state.user ? { server: previousServer ?? state.server, userId: state.user.id } : undefined);
  const store = credentialStore(useCredentialFile, root);
  const previousCredentials = store.load();
  const authConfig = await api<{ provider: "github"; clientId: string }>(state, "/v1/auth/config");
  const githubResponse = await retryTransientFetch(() =>
    fetch("https://github.com/login/device/code", {
      method: "POST",
      redirect: "error",
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
        redirect: "error",
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
    const identity = { server: state.server, userId: authorized.user.id };
    const sameIdentity = Boolean(
      previousIdentity &&
      previousIdentity.server === identity.server &&
      previousIdentity.userId === identity.userId,
    );
    store.save({
      accessToken: authorized.accessToken,
      refreshToken: authorized.refreshToken,
      ...(sameIdentity && previousCredentials?.accountKey
        ? { accountKey: previousCredentials.accountKey }
        : {}),
    });
    if (!sameIdentity) resetSyncProgress(state);
    state.credentialStore = useCredentialFile ? "file" : "system";
    state.syncIdentity = identity;
    state.user = authorized.user;
    writeState(state, root);
    return { login: authorized.user.login, credentialStore: store.description };
  }
  throw new Error("Device authorization expired.");
}

export function syncLogin(options: {
  server?: string;
  allowCredentialFile?: boolean;
  onChallenge: (verificationUri: string, userCode: string) => void;
}): Promise<{ login: string; credentialStore: string }> {
  return withSyncOperationLock(() => syncLoginUnlocked(options));
}

async function enableSyncUnlocked(passphrase: string, allowFile = false): Promise<void> {
  const state = readState();
  if (!state?.user) throw new Error("Run `airo sync login` first.");
  const store = credentialStoreForState(state, allowFile);
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
  // authenticated() may have rotated and persisted the tokens while fetching
  // the account key. Never overwrite those replacements with the stale copy.
  const currentCredentials = store.load();
  if (!currentCredentials)
    throw new Error("Sync credentials disappeared while encrypted sync was being enabled.");
  store.save({ ...currentCredentials, accountKey: encodeAccountKey(key) });
  state.enabled = true;
  writeState(state);
}

export function enableSync(passphrase: string, allowFile = false): Promise<void> {
  return withSyncOperationLock(() => enableSyncUnlocked(passphrase, allowFile));
}

function eventContext(event: Pick<SyncEvent, "id" | "kind">): string {
  return `event:${event.kind}:${event.id}`;
}

type LocalSyncRecord = {
  kind: SyncDataKind;
  record: { id: string; timestamp?: string; repositoryId?: string };
};

function localRecords(config: RouterConfig): LocalSyncRecord[] {
  return withFileLocks(
    [
      `${historyPath(config.history)}.lock`,
      `${feedbackPath(config.history)}.lock`,
      `${jevFeedbackPath(config.history)}.lock`,
    ],
    () => [
      ...readHistory(config.history).map((record) => ({ kind: "history" as const, record })),
      ...readFeedback(config.history).map((record) => ({ kind: "feedback" as const, record })),
      ...readJevFeedback(config.history).map((record) => ({
        kind: "jev-feedback" as const,
        record,
      })),
    ],
  );
}

function recordVersion(key: Buffer, record: unknown): string {
  return crypto.createHmac("sha256", key).update(JSON.stringify(record)).digest("base64url");
}

function operationVersion(key: Buffer): string {
  return crypto.createHmac("sha256", key).update(crypto.randomUUID()).digest("base64url");
}

function recordManifest(records: LocalSyncRecord[], key: Buffer): SyncRecordManifest {
  const manifest: SyncRecordManifest = { history: {}, feedback: {}, "jev-feedback": {} };
  for (const { kind, record } of records) manifest[kind]![record.id] = recordVersion(key, record);
  return manifest;
}

function localEvents(
  records: LocalSyncRecord[],
  key: Buffer,
  previous: SyncRecordManifest = {},
): SyncEvent[] {
  const make = (
    kind: SyncDataKind,
    record: { id: string; timestamp?: string; repositoryId?: string },
  ): SyncEvent => {
    return {
      id: record.id,
      // Each transition needs its own version so create-delete-restore cycles
      // are not mistaken for duplicates by the server.
      version: operationVersion(key),
      kind,
      repositoryId: record.repositoryId ? syncRepositoryId(key, record.repositoryId) : undefined,
      createdAt: Math.floor(new Date(record.timestamp ?? 0).getTime() / 1000) || 0,
      envelope: encryptSyncPayload(key, record, `event:${kind}:${record.id}`),
    };
  };
  const current = recordManifest(records, key);
  const events = records
    .filter(({ kind, record }) => previous[kind]?.[record.id] !== current[kind]?.[record.id])
    .map(({ kind, record }) => make(kind, record));
  for (const kind of ["history", "feedback", "jev-feedback"] as const) {
    for (const [id, deletedVersion] of Object.entries(previous[kind] ?? {})) {
      if (current[kind]?.[id]) continue;
      const tombstone = { id, targetKind: kind, deletedVersion };
      events.push({
        id,
        version: operationVersion(key),
        kind: "tombstone",
        createdAt: Math.floor(Date.now() / 1000),
        envelope: encryptSyncPayload(key, tombstone, `event:tombstone:${id}`),
      });
    }
  }
  return events;
}

function readJsonLines<T extends { id: string }>(file: string): Map<string, T> {
  const records: T[] = fs.existsSync(file)
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
  return new Map(records.map((record) => [record.id, record]));
}

function writeJsonLines(file: string, records: Map<string, { id: string }>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const serialized = [...records.values()].map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(temporary, serialized ? `${serialized}\n` : "", { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function syncFile(config: RouterConfig, kind: SyncDataKind): string {
  if (kind === "history") return historyPath(config.history);
  if (kind === "feedback") return feedbackPath(config.history);
  return jevFeedbackPath(config.history);
}

function applyEventPage(
  config: RouterConfig,
  key: Buffer,
  events: SyncEvent[],
  previous: SyncRecordManifest = {},
): { changed: number; manifest: SyncRecordManifest } {
  const manifest = structuredClone(previous);
  const operations = new Map<SyncDataKind, Map<string, { id: string; record?: { id: string } }>>();
  const add = (kind: SyncDataKind, operation: { id: string; record?: { id: string } }) => {
    const current = operations.get(kind) ?? new Map();
    current.set(operation.id, operation);
    operations.set(kind, current);
  };
  for (const event of events) {
    if (event.kind === "tombstone") {
      const tombstone = decryptSyncPayload<{ id: string; targetKind: SyncDataKind }>(
        key,
        event.envelope,
        eventContext(event),
      );
      if (
        tombstone.id !== event.id ||
        !["history", "feedback", "jev-feedback"].includes(tombstone.targetKind)
      )
        throw new Error(`Sync tombstone ${event.id} failed validation.`);
      add(tombstone.targetKind, { id: event.id });
      delete manifest[tombstone.targetKind]?.[event.id];
      continue;
    }
    const record = decryptSyncPayload<{ id: string }>(key, event.envelope, eventContext(event));
    if (record.id !== event.id)
      throw new Error(`Sync event ${event.id} failed identity validation.`);
    add(event.kind, { id: event.id, record });
    (manifest[event.kind] ??= {})[event.id] = recordVersion(key, record);
  }
  let changed = 0;
  for (const [kind, kindOperations] of operations) {
    const file = syncFile(config, kind);
    changed += withFileLock(`${file}.lock`, () => {
      const records = readJsonLines(file);
      let kindChanged = 0;
      for (const operation of kindOperations.values()) {
        const existing = records.get(operation.id);
        const existingVersion = existing ? recordVersion(key, existing) : undefined;
        const expectedVersion = previous[kind]?.[operation.id];
        const incomingVersion = operation.record ? recordVersion(key, operation.record) : undefined;
        const locallyChanged = existingVersion !== expectedVersion;
        const remotelyChangesFile = existingVersion !== incomingVersion;
        // A writer changed this ID after the push snapshot. Preserve that
        // local transition; leaving the remote version in the manifest makes
        // the next sync push the preserved local value (or tombstone).
        if (locallyChanged && remotelyChangesFile) continue;
        if (!operation.record) {
          if (records.delete(operation.id)) kindChanged++;
          continue;
        }
        if (!existing || JSON.stringify(existing) !== JSON.stringify(operation.record)) {
          records.set(operation.id, operation.record);
          kindChanged++;
        }
      }
      if (kindChanged) writeJsonLines(file, records);
      return kindChanged;
    });
  }
  return { changed, manifest };
}

function eventBatches(events: SyncEvent[], maxBytes = 900_000, maxEvents = 100): string[] {
  const bodies: string[] = [];
  let batch: SyncEvent[] = [];
  for (const event of events) {
    const candidate = [...batch, event];
    const body = JSON.stringify({ events: candidate });
    if (candidate.length <= maxEvents && Buffer.byteLength(body) <= maxBytes) {
      batch = candidate;
      continue;
    }
    if (!batch.length) throw new Error(`Sync event ${event.id} exceeds the request size limit.`);
    bodies.push(JSON.stringify({ events: batch }));
    batch = [event];
    const single = JSON.stringify({ events: batch });
    if (Buffer.byteLength(single) > maxBytes)
      throw new Error(`Sync event ${event.id} exceeds the request size limit.`);
  }
  if (batch.length) bodies.push(JSON.stringify({ events: batch }));
  return bodies;
}

function manifestAfterEvents(
  previous: SyncRecordManifest | undefined,
  events: SyncEvent[],
  key: Buffer,
): SyncRecordManifest {
  const manifest = structuredClone(previous ?? {});
  for (const event of events) {
    if (event.kind === "tombstone") {
      const tombstone = decryptSyncPayload<{ id: string; targetKind: SyncDataKind }>(
        key,
        event.envelope,
        eventContext(event),
      );
      if (
        tombstone.id !== event.id ||
        !["history", "feedback", "jev-feedback"].includes(tombstone.targetKind)
      )
        throw new Error(`Sync tombstone ${event.id} failed validation.`);
      delete manifest[tombstone.targetKind]?.[event.id];
      continue;
    }
    const record = decryptSyncPayload<{ id: string }>(key, event.envelope, eventContext(event));
    if (record.id !== event.id)
      throw new Error(`Sync event ${event.id} failed identity validation.`);
    (manifest[event.kind] ??= {})[event.id] = recordVersion(key, record);
  }
  return manifest;
}

async function syncNowUnlocked(
  _config: RouterConfig,
  allowFile = false,
): Promise<{ pushed: number; pulled: number }> {
  const state = readState();
  if (!state?.enabled) throw new Error("Sync is disabled. Run `airo sync enable`.");
  const store = credentialStoreForState(state, allowFile);
  const credentials = store.load();
  if (!credentials?.accountKey)
    throw new Error("The local account key is missing. Run `airo sync enable`.");
  const key = Buffer.from(credentials.accountKey, "base64url");
  const loadedGlobal = loadGlobalConfig();
  const globalConfig = loadedGlobal.config;
  const syncConfig: RouterConfig = {
    ...globalConfig,
    history: {
      ...globalConfig.history,
      enabled: true,
      path: globalConfig.history.path
        ? path.resolve(
            path.dirname(loadedGlobal.path ?? syncStatePath()),
            globalConfig.history.path,
          )
        : undefined,
    },
  };
  const recordsPath = historyPath(syncConfig.history);
  let pushed = 0;
  // Finish a durable pending batch first, then take one fresh snapshot to
  // catch records written while that request was in flight.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    if (state.pendingEvents?.length) {
      for (const body of eventBatches(state.pendingEvents)) {
        const result = await authenticated<{ accepted: number }>(state, store, "/v1/sync/push", {
          method: "POST",
          body,
        });
        pushed += result.accepted;
      }
      state.records =
        state.pendingRecords ?? manifestAfterEvents(state.records, state.pendingEvents, key);
      state.recordsPath = state.pendingRecordsPath ?? recordsPath;
      delete state.pendingEvents;
      delete state.pendingRecords;
      delete state.pendingRecordsPath;
      writeState(state);
      continue;
    }
    const records = localRecords(syncConfig);
    const nextManifest = recordManifest(records, key);
    const previousManifest = state.recordsPath === recordsPath ? state.records : undefined;
    const events = localEvents(records, key, previousManifest);
    if (!events.length) {
      if (state.recordsPath !== recordsPath) {
        state.records = nextManifest;
        state.recordsPath = recordsPath;
        writeState(state);
      }
      break;
    }
    if (state.recordsPath !== recordsPath) {
      state.records = {};
      state.recordsPath = recordsPath;
    }
    for (const body of eventBatches(events)) {
      const batch = (JSON.parse(body) as { events: SyncEvent[] }).events;
      // Persist only the bounded request currently in flight. A crash after
      // the server accepts it safely retries the same operation versions.
      state.pendingEvents = batch;
      state.pendingRecordsPath = recordsPath;
      writeState(state);
      const result = await authenticated<{ accepted: number }>(state, store, "/v1/sync/push", {
        method: "POST",
        body,
      });
      pushed += result.accepted;
      state.records = manifestAfterEvents(state.records, batch, key);
      state.recordsPath = recordsPath;
      delete state.pendingEvents;
      delete state.pendingRecordsPath;
      writeState(state);
    }
  }
  let pulled = 0;
  let hasMore = true;
  while (hasMore) {
    const result = await authenticated<{ events: SyncEvent[]; cursor: number; hasMore: boolean }>(
      state,
      store,
      `/v1/sync/pull?cursor=${state.cursor}&limit=100`,
    );
    const applied = applyEventPage(syncConfig, key, result.events, state.records);
    pulled += applied.changed;
    state.records = applied.manifest;
    state.recordsPath = recordsPath;
    state.cursor = result.cursor;
    writeState(state);
    hasMore = result.hasMore;
  }

  // Repository overrides affect the current run and its local history, but
  // account-wide cloud settings always originate from the global config.
  const localSettings = safeSyncSettings(globalConfig);
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
        writeGlobalConfig(applySafeSettings(globalConfig, remoteSettings));
      state.settingsRevision = routing.revision;
      state.settingsDigest = remoteDigest;
    }
  }
  state.lastSyncAt = new Date().toISOString();
  writeState(state);
  return { pushed, pulled };
}

export async function syncNow(
  config: RouterConfig,
  allowFile = false,
): Promise<{ pushed: number; pulled: number }> {
  return withSyncOperationLock(() => syncNowUnlocked(config, allowFile));
}

export function syncStatus(allowFile = false): {
  state?: SyncState;
  credentials: boolean;
  credentialStore?: string;
} {
  const state = readState();
  try {
    const store = credentialStoreForState(state, allowFile);
    return { state, credentials: Boolean(store.load()), credentialStore: store.description };
  } catch {
    return { state, credentials: false };
  }
}

export async function syncDevices(allowFile = false): Promise<
  Array<{
    id: string;
    name: string;
    lastSeenAt: number;
    revokedAt: number | null;
    current: boolean;
  }>
> {
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  return (
    await authenticated<{
      devices: Array<{
        id: string;
        name: string;
        lastSeenAt: number;
        revokedAt: number | null;
        current: boolean;
      }>;
    }>(state, credentialStoreForState(state, allowFile), "/v1/devices")
  ).devices;
}

export async function syncRevokeDevice(deviceId: string, allowFile = false): Promise<void> {
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(deviceId)) throw new Error("Invalid device ID.");
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  await authenticated(state, credentialStoreForState(state, allowFile), `/v1/devices/${deviceId}`, {
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
  const store = credentialStoreForState(state, options.allowFile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const spoolDirectory = fs.mkdtempSync(path.join(path.dirname(file), ".airo-export-"));
  const spools = {
    events: path.join(spoolDirectory, "events.json"),
    devices: path.join(spoolDirectory, "devices.json"),
    settings: path.join(spoolDirectory, "settings.json"),
  };
  let eventCursor = 0;
  let deviceOffset = 0;
  let settingOffset = 0;
  let metadata: Record<string, unknown> | undefined;
  let hasEvents = false;
  let hasDevices = false;
  let hasSettings = false;
  let hasMore = true;
  try {
    for (const spool of Object.values(spools)) fs.writeFileSync(spool, "", { mode: 0o600 });
    while (hasMore) {
      const page = await authenticated<
        Record<string, unknown> & {
          events: unknown[];
          devices: unknown[];
          settings: unknown[];
          eventCursor: number;
          deviceOffset: number;
          settingOffset: number;
          hasMore: boolean;
        }
      >(
        state,
        store,
        `/v1/account/export?paged=1&eventCursor=${eventCursor}&deviceOffset=${deviceOffset}&settingOffset=${settingOffset}&limit=50`,
      );
      if (!metadata) {
        const {
          eventCursor: _eventCursor,
          deviceOffset: _deviceOffset,
          settingOffset: _settingOffset,
          hasMore: _hasMore,
          events: _events,
          devices: _devices,
          settings: _settings,
          ...pageMetadata
        } = page;
        metadata = pageMetadata;
      }
      hasEvents = appendJsonItems(spools.events, page.events, hasEvents);
      hasDevices = appendJsonItems(spools.devices, page.devices, hasDevices);
      hasSettings = appendJsonItems(spools.settings, page.settings, hasSettings);
      if (
        page.hasMore &&
        page.eventCursor <= eventCursor &&
        page.deviceOffset <= deviceOffset &&
        page.settingOffset <= settingOffset
      )
        throw new Error("Cloud account export did not advance any collection cursor.");
      eventCursor = page.eventCursor;
      deviceOffset = page.deviceOffset;
      settingOffset = page.settingOffset;
      hasMore = page.hasMore;
    }
    if (!metadata) throw new Error("Cloud account export returned no data.");
    writeCloudExport(file, metadata, [
      { key: "events", spool: spools.events },
      { key: "devices", spool: spools.devices },
      { key: "settings", spool: spools.settings },
    ]);
    return file;
  } finally {
    fs.rmSync(spoolDirectory, { recursive: true, force: true });
  }
}

async function syncLogoutUnlocked(allowFile = false): Promise<void> {
  const state = readState();
  if (!state) return;
  const store = credentialStoreForState(state, allowFile);
  await authenticated(state, store, "/v1/auth/logout", { method: "POST" }).catch(() => undefined);
  store.clear();
  state.enabled = false;
  state.user = undefined;
  writeState(state);
}

export function syncLogout(allowFile = false): Promise<void> {
  return withSyncOperationLock(() => syncLogoutUnlocked(allowFile));
}

async function deleteCloudDataUnlocked(allowFile = false): Promise<void> {
  const state = readState();
  if (!state) throw new Error("Sync is not configured.");
  const store = credentialStoreForState(state, allowFile);
  await authenticated(state, store, "/v1/account", {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  store.clear();
  try {
    fs.unlinkSync(syncStatePath());
  } catch {}
}

export function deleteCloudData(allowFile = false): Promise<void> {
  return withSyncOperationLock(() => deleteCloudDataUnlocked(allowFile));
}
