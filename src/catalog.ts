import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Agent, Effort, ModelProfile, ModelTier, RouterConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { dataRootDir } from "./paths.js";
import { AGENTS, providerDefinition } from "./providers.js";
import {
  loginShellEnvironment,
  readJson,
  readTomlTableValue,
  readTomlValue,
  runProviderCommand,
} from "./provider-shell.js";

export type CatalogSource =
  | "cli"
  | "catalog-file"
  | "provider-config"
  | "environment"
  | "gateway"
  | "builtin";

export interface CatalogModel {
  id: string;
  label?: string;
  efforts?: string[];
}

export interface ProviderCatalog {
  agent: Agent;
  models: CatalogModel[];
  /** Models returned by the provider probe, before configured fallbacks are appended. */
  detectedModels: CatalogModel[];
  /** Where the ids came from. `builtin` means every probe came back empty. */
  source: CatalogSource;
  /** How the probe was performed, for `airo doctor`. */
  via?: string;
  probedAt: string;
  /** Command identity; a provider upgrade invalidates the cached entry. */
  fingerprint: string;
  /** Hash of configuration, environment and project inputs used by the probe. */
  contextFingerprint: string;
  /** Why a probe produced nothing. */
  note?: string;
}

export interface CatalogOptions {
  /** Ignore the cache and probe again. */
  refresh?: boolean;
  /** Allow the gateway HTTP probe. Off during a run so routing stays free. */
  online?: boolean;
  /** Re-run the provider executable to verify its version before reusing cache. */
  verifyExecutable?: boolean;
  ttlMs?: number;
  cwd?: string;
}

export interface CatalogContextInputs {
  cwd?: string;
  files: string[];
  environment: string[];
}

export interface ProviderCatalogAdapter {
  probeLocal: (command: string, cwd: string) => Partial<ProviderCatalog>;
  contextInputs: (config: RouterConfig, cwd: string) => CatalogContextInputs;
  gateway?: () => { base: string; token?: string } | undefined;
}

const CACHE_VERSION = 4;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export { AGENTS } from "./providers.js";

interface CacheFile {
  version: number;
  entries: Partial<Record<Agent, ProviderCatalog>>;
}

function cachePath(): string {
  const dir = dataRootDir();
  return path.join(dir, "model-catalog.json");
}

function readCache(): CacheFile {
  const parsed = readJson(cachePath());
  if (
    !parsed ||
    parsed.version !== CACHE_VERSION ||
    typeof parsed.entries !== "object" ||
    !parsed.entries ||
    Array.isArray(parsed.entries)
  )
    return { version: CACHE_VERSION, entries: {} };
  return parsed as CacheFile;
}

function writeCache(entry: ProviderCatalog) {
  const cache = readCache();
  cache.entries[entry.agent] = entry;
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    /* a catalogue we cannot cache is still usable in memory */
  }
}

/**
 * Identity of the installed CLI. `commandVersion` is not reused here because
 * that helper lives in the runner and runs without the login shell; probes and
 * their fingerprints have to agree on which binary they are talking about.
 */
function fingerprintFor(command: string): string {
  const probe = runProviderCommand(command, ["--version"]);
  if (!probe.result || probe.result.error) return `${command}@missing`;
  const output = (probe.result.stdout || probe.result.stderr || "").trim().split(/\r?\n/)[0];
  return `${probe.command ?? command}@${output || "unknown"}`;
}

function fileFingerprint(file: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

function contextFingerprintFor(agent: Agent, config: RouterConfig, cwd: string): string {
  const context = providerCatalogAdapter(agent).contextInputs(config, cwd);
  const input = {
    agent,
    provider: config[agent],
    cwd: context.cwd,
    files: context.files.map((file) => [file, fileFingerprint(file)]),
    environment: context.environment.map((key) => [key, process.env[key] ?? null]),
  };
  // Hashing keeps credentials and provider configuration out of the cache file.
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function unique(models: CatalogModel[]): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    // The first sighting wins; later ones only fill in missing detail.
    const existing = byId.get(id);
    byId.set(id, {
      id,
      label: existing?.label ?? model.label,
      efforts: existing?.efforts ?? model.efforts,
    });
  }
  return [...byId.values()];
}

function configuredModels(agent: Agent, config: RouterConfig): CatalogModel[] {
  return unique([
    ...Object.values(config[agent].models).map((profile) => ({ id: profile.model })),
    ...(config[agent].allowedModels ?? []).map((id) => ({ id })),
    ...Object.values(DEFAULT_CONFIG[agent].models).map((profile) => ({ id: profile.model })),
  ]);
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Parse the shape `codex debug models` and codex's catalog files both use. */
function codexCatalogModels(raw: unknown): CatalogModel[] {
  const list = (raw as any)?.models;
  if (!Array.isArray(list)) return [];
  const models: CatalogModel[] = [];
  for (const entry of list) {
    const id = typeof entry?.slug === "string" ? entry.slug : entry?.id;
    if (typeof id !== "string" || !id.trim()) continue;
    // Hidden entries are internal (reviewers, reserved capacity), not user choices.
    if (entry?.visibility === "hide") continue;
    const efforts = Array.isArray(entry?.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((level: any) => (typeof level === "string" ? level : level?.effort))
          .filter((effort: unknown): effort is string => typeof effort === "string")
      : undefined;
    models.push({
      id: id.trim(),
      label: typeof entry?.display_name === "string" ? entry.display_name : undefined,
      efforts: efforts?.length ? efforts : undefined,
    });
  }
  return models;
}

/**
 * Whether a CLI advertises a subcommand. Guessing is not safe: codex treats an
 * unknown subcommand as a prompt, so an unguarded probe would hang instead of
 * failing.
 */
function advertisesSubcommand(command: string, subcommand: string): boolean {
  const probe = runProviderCommand(command, ["--help"]);
  if (!probe.result) return false;
  const help = `${probe.result.stdout || ""}\n${probe.result.stderr || ""}`;
  return new RegExp(`^\\s+${subcommand}\\b`, "m").test(help);
}

function probeCodex(command: string): Partial<ProviderCatalog> {
  if (advertisesSubcommand(command, "debug")) {
    const probe = runProviderCommand(command, ["debug", "models"]);
    if (probe.result?.status === 0) {
      const models = codexCatalogModels(readJsonText(probe.result.stdout || ""));
      if (models.length) return { models, source: "cli", via: `${command} debug models` };
    }
  }
  const home = codexHome();
  const catalogFile = readTomlValue(path.join(home, "config.toml"), "model_catalog_json");
  for (const file of [catalogFile, path.join(home, "models_cache.json")]) {
    if (!file) continue;
    const models = codexCatalogModels(readJson(file.replace(/^~(?=\/)/, os.homedir())));
    if (models.length) return { models, source: "catalog-file", via: file };
  }
  return { note: `${command} exposes no model catalog` };
}

function readJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Claude Code has no model-listing command. It does honour
 * ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL, which map exactly onto AIRO's
 * three tiers, so a gateway deployment states its own ids there.
 */
function probeClaude(cwd: string): Partial<ProviderCatalog> {
  const environment = loginShellEnvironment();
  const fromEnvironment = ["HAIKU", "SONNET", "OPUS"]
    .map((alias) => ({
      id: environment[`ANTHROPIC_DEFAULT_${alias}_MODEL`]?.trim() ?? "",
      label: alias.toLowerCase(),
    }))
    .filter((model) => model.id);
  const settings = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ]
    .map((file) => readJson(file)?.model)
    .filter((model: unknown): model is string => typeof model === "string" && Boolean(model.trim()))
    .map((id: string) => ({ id: id.trim() }));
  const projects = readJson(path.join(os.homedir(), ".claude.json"))?.projects;
  const fromProjects: CatalogModel[] = Object.values(projects ?? {})
    .map((project: any) => project?.model)
    .filter((model: unknown): model is string => typeof model === "string" && Boolean(model.trim()))
    .map((id: string) => ({ id: id.trim() }));

  const models = unique([...fromEnvironment, ...settings, ...fromProjects]);
  if (!models.length) return { note: "no ANTHROPIC_DEFAULT_*_MODEL or configured model found" };
  return {
    models,
    source: fromEnvironment.length ? "environment" : "provider-config",
    via: fromEnvironment.length ? "ANTHROPIC_DEFAULT_*_MODEL" : "claude settings",
  };
}

/**
 * Generic path for a CLI that may grow a `models` subcommand. Only runs when
 * the CLI's own help advertises it, and accepts either JSON or one id per line.
 */
function probeGenericCli(command: string): Partial<ProviderCatalog> {
  if (!advertisesSubcommand(command, "models"))
    return { note: `${command} has no models subcommand` };
  for (const args of [["models", "list"], ["models"]]) {
    const probe = runProviderCommand(command, args);
    if (probe.result?.status !== 0) continue;
    const text = probe.result.stdout || "";
    const parsed = readJsonText(text) as any;
    const list = Array.isArray(parsed) ? parsed : (parsed?.models ?? parsed?.data);
    const models = Array.isArray(list)
      ? unique(
          list
            .map((entry: any) => (typeof entry === "string" ? entry : (entry?.id ?? entry?.slug)))
            .filter((id: unknown): id is string => typeof id === "string")
            .map((id: string) => ({ id: id.trim() })),
        )
      : unique(
          text
            .split(/\r?\n/)
            .map((line: string) => line.trim())
            .filter((line: string) => /^[a-z0-9][a-z0-9._:\-[\]]*$/i.test(line))
            .map((id: string) => ({ id })),
        );
    if (models.length) return { models, source: "cli", via: `${command} ${args.join(" ")}` };
  }
  return { note: `${command} listed no models` };
}

function claudeContextInputs(_config: RouterConfig, cwd: string): CatalogContextInputs {
  const home = os.homedir();
  return {
    cwd: path.resolve(cwd),
    files: [
      path.join(home, ".claude", "settings.json"),
      path.join(home, ".claude.json"),
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
    ],
    environment: [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ],
  };
}

function codexContextInputs(): CatalogContextInputs {
  const config = path.join(codexHome(), "config.toml");
  const provider = readTomlValue(config, "model_provider");
  const envKey = provider
    ? readTomlTableValue(config, ["model_providers", provider], "env_key")
    : undefined;
  return {
    files: [config, path.join(codexHome(), "models_cache.json")],
    environment: ["CODEX_HOME", "OPENAI_API_KEY", ...(envKey ? [envKey] : [])],
  };
}

function noContextInputs(): CatalogContextInputs {
  return { files: [], environment: [] };
}

function claudeGateway(): { base: string; token?: string } | undefined {
  const environment = loginShellEnvironment();
  const base = environment.ANTHROPIC_BASE_URL?.trim();
  const token = environment.ANTHROPIC_AUTH_TOKEN?.trim() || environment.ANTHROPIC_API_KEY?.trim();
  return base ? { base, token } : undefined;
}

function codexGateway(): { base: string; token?: string } | undefined {
  const environment = loginShellEnvironment();
  const config = path.join(codexHome(), "config.toml");
  const provider = readTomlValue(config, "model_provider");
  if (!provider) return undefined;
  const table = ["model_providers", provider];
  const base = readTomlTableValue(config, table, "base_url");
  const envKey = readTomlTableValue(config, table, "env_key");
  // codex may take its token from an `auth.command`; running that is out of
  // scope for a probe, so the gateway call is only attempted with a token
  // that is already in the environment.
  const token = envKey ? environment[envKey]?.trim() : undefined;
  return base ? { base, token } : undefined;
}

export const PROVIDER_CATALOG_ADAPTERS: Record<Agent, ProviderCatalogAdapter> = {
  claude: {
    probeLocal: (_command, cwd) => probeClaude(cwd),
    contextInputs: claudeContextInputs,
    gateway: claudeGateway,
  },
  codex: {
    probeLocal: (command) => probeCodex(command),
    contextInputs: codexContextInputs,
    gateway: codexGateway,
  },
  gemini: { probeLocal: probeGenericCli, contextInputs: noContextInputs },
  copilot: { probeLocal: probeGenericCli, contextInputs: noContextInputs },
};

export function providerCatalogAdapter(agent: Agent): ProviderCatalogAdapter {
  return PROVIDER_CATALOG_ADAPTERS[agent];
}

/**
 * Ask an OpenAI-compatible gateway what the key may route to. The answer is a
 * superset of what a given CLI accepts (it spans wire protocols), so it only
 * ever fills in for an empty local probe — it must not replace a CLI catalogue.
 */
async function probeGateway(agent: Agent): Promise<Partial<ProviderCatalog>> {
  const gateway = providerCatalogAdapter(agent).gateway?.();
  if (!gateway?.token) return {};
  const base = gateway.base.replace(/\/+$/, "");
  const urls = /\/v\d+$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${gateway.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const list = (await response.json())?.data;
      if (!Array.isArray(list)) continue;
      const models = unique(
        list
          .map((entry: any) => ({
            id: typeof entry?.id === "string" ? entry.id.trim() : "",
            label: typeof entry?.display_name === "string" ? entry.display_name : undefined,
          }))
          .filter((model) => model.id),
      );
      if (models.length) return { models, source: "gateway", via: url };
    } catch {
      /* offline or unauthenticated: the local probes already answered */
    }
  }
  return {};
}

function probeLocal(agent: Agent, config: RouterConfig, cwd: string): Partial<ProviderCatalog> {
  return providerCatalogAdapter(agent).probeLocal(config[agent].command, cwd);
}

function finish(
  agent: Agent,
  config: RouterConfig,
  probe: Partial<ProviderCatalog>,
  fingerprint: string,
  contextFingerprint: string,
): ProviderCatalog {
  const discovered = probe.models ?? [];
  return {
    agent,
    // The configured and built-in ids are always offered: a probe that fails
    // must never shrink what AIRO can route to.
    models: unique([...discovered, ...configuredModels(agent, config)]),
    detectedModels: unique(discovered),
    source: discovered.length ? (probe.source ?? "cli") : "builtin",
    via: discovered.length ? probe.via : undefined,
    note: discovered.length ? undefined : probe.note,
    probedAt: new Date().toISOString(),
    fingerprint,
    contextFingerprint,
  };
}

/** Cached catalogue for one provider. Never probes; use `discoverCatalog` for that. */
export function cachedCatalog(agent: Agent): ProviderCatalog | undefined {
  const entry = readCache().entries[agent];
  if (
    !entry ||
    entry.agent !== agent ||
    !Array.isArray(entry.models) ||
    !entry.models.every((model) => model && typeof model.id === "string" && model.id.trim()) ||
    !Array.isArray(entry.detectedModels) ||
    !entry.detectedModels.every(
      (model) => model && typeof model.id === "string" && model.id.trim(),
    ) ||
    typeof entry.fingerprint !== "string" ||
    typeof entry.contextFingerprint !== "string" ||
    !Number.isFinite(Date.parse(entry.probedAt))
  )
    return undefined;
  return entry;
}

/**
 * Models a provider can actually run, from its own CLI, its config files and
 * the environment, cached on disk with a TTL. Offline and unauthenticated
 * probes degrade to the configured and built-in ids rather than failing.
 */
export async function discoverCatalog(
  agent: Agent,
  config: RouterConfig,
  options: CatalogOptions = {},
): Promise<ProviderCatalog> {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const cwd = options.cwd ?? process.cwd();
  const contextFingerprint = contextFingerprintFor(agent, config, cwd);
  const cached = cachedCatalog(agent);
  const reusable =
    !options.refresh &&
    cached &&
    cached.contextFingerprint === contextFingerprint &&
    (!options.online || cached.source !== "builtin") &&
    Date.now() - Date.parse(cached.probedAt) < ttl;
  if (reusable && options.verifyExecutable === false) return cached;

  const fingerprint = fingerprintFor(config[agent].command);
  if (
    reusable &&
    cached.fingerprint === fingerprint &&
    cached.contextFingerprint === contextFingerprint
  )
    return cached;

  const probe = probeLocal(agent, config, cwd);
  const enriched =
    options.online && !probe.models?.length ? { ...probe, ...(await probeGateway(agent)) } : probe;
  const entry = finish(agent, config, enriched, fingerprint, contextFingerprint);
  writeCache(entry);
  return entry;
}

export async function discoverCatalogs(
  config: RouterConfig,
  options: CatalogOptions = {},
): Promise<Record<Agent, ProviderCatalog>> {
  const entries = await Promise.all(
    AGENTS.map(async (agent) => [agent, await discoverCatalog(agent, config, options)] as const),
  );
  return Object.fromEntries(entries) as Record<Agent, ProviderCatalog>;
}

/**
 * Models to try for a provider, best first, for a run that must not block on a
 * probe: the cached catalogue if there is one, otherwise the configured ids.
 */
export function candidateModels(agent: Agent, config: RouterConfig): CatalogModel[] {
  const cached = cachedCatalog(agent);
  return unique([...(cached?.models ?? []), ...configuredModels(agent, config)]);
}

const TIER_SIGNALS: Record<ModelTier, RegExp> = {
  fast: /(?:^|[-_.\s])(fast|flash|haiku|luna|lite|mini|nano|small)(?:$|[-_.\s])/i,
  balanced: /(?:^|[-_.\s])(auto|balanced|standard|sonnet|terra|medium)(?:$|[-_.\s])/i,
  deep: /(?:^|[-_.\s])(astra|deep|large|max|opus|pro|reasoning|sol|ultra)(?:$|[-_.\s])/i,
};

const EFFORTS: readonly Effort[] = [
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function supportsEffort(model: CatalogModel, effort: Effort): boolean {
  return !model.efforts?.length || model.efforts.includes(effort);
}

function tierEffort(tier: ModelTier, current: Effort | undefined, model: CatalogModel): Effort {
  const requested = current ?? (tier === "fast" ? "low" : tier === "balanced" ? "medium" : "high");
  if (supportsEffort(model, requested)) return requested;
  const supported = (model.efforts ?? []).filter((value): value is Effort =>
    EFFORTS.includes(value as Effort),
  );
  if (!supported.length) return requested;
  const preferred =
    tier === "fast"
      ? ["low", "minimal", "medium", "high", "xhigh", "max", "ultra", "auto"]
      : tier === "balanced"
        ? ["medium", "high", "low", "xhigh", "minimal", "max", "ultra", "auto"]
        : ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "auto"];
  return preferred.find((effort) => supported.includes(effort as Effort)) as Effort;
}

function modelText(model: CatalogModel): string {
  return `${model.id} ${model.label ?? ""}`;
}

function selectDetectedModel(
  catalog: ProviderCatalog,
  tier: ModelTier,
  current: ModelProfile,
): CatalogModel | undefined {
  const detected = catalog.detectedModels;
  if (!detected.length) return undefined;
  const signaled = detected.find((model) => TIER_SIGNALS[tier].test(modelText(model)));
  if (signaled) return signaled;
  const currentDetected = detected.find((model) => model.id === current.model);
  if (currentDetected) return currentDetected;
  // Settings and environment probes reveal configured choices, not the full
  // entitlement catalogue. Do not stretch one configured model across tiers.
  if (catalog.source === "environment" || catalog.source === "provider-config") return undefined;
  const index =
    tier === "deep"
      ? 0
      : tier === "fast"
        ? detected.length - 1
        : Math.floor((detected.length - 1) / 2);
  return detected[index];
}

/**
 * Overlay provider-discovered models onto the reviewed tier profiles used by
 * the synchronous router. Explicit manual mode keeps configuration untouched.
 */
export function resolveDynamicModels(
  config: RouterConfig,
  catalogs: Record<Agent, ProviderCatalog>,
): RouterConfig {
  if (config.modelRouting.mode === "manual") return config;
  const resolved = structuredClone(config);
  for (const agent of AGENTS) {
    for (const tier of ["fast", "balanced", "deep"] as const) {
      const fallback = DEFAULT_CONFIG[agent].models[tier];
      const selected = selectDetectedModel(catalogs[agent], tier, fallback);
      const effort = providerDefinition(agent).capabilities.effortControl
        ? selected
          ? tierEffort(tier, fallback.effort, selected)
          : fallback.effort
        : "auto";
      resolved[agent].models[tier] = {
        model: selected?.id ?? fallback.model,
        effort,
      };
    }
  }
  return resolved;
}

export function catalogAge(entry: ProviderCatalog, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(entry.probedAt));
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
