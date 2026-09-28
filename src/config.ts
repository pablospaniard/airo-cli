import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Agent, Policy, RouterConfig } from "./types.js";

export const CONFIG_NOTE =
  "AIRO discovers provider models automatically. Set modelRouting.mode to manual to pin the provider tier mappings below.";

export const DEFAULT_CONFIG: RouterConfig = {
  policy: "balanced",
  defaultAgent: "codex",
  modelRouting: { mode: "dynamic" },
  claude: {
    command: "claude",
    args: [],
    permissionMode: "acceptEdits",
    models: {
      fast: { model: "haiku", effort: "low" },
      balanced: { model: "sonnet", effort: "medium" },
      deep: { model: "opus", effort: "high" },
    },
  },
  codex: {
    command: "codex",
    args: [],
    models: {
      fast: { model: "gpt-5.6-luna", effort: "low" },
      balanced: { model: "gpt-5.6-terra", effort: "medium" },
      deep: { model: "gpt-5.6-sol", effort: "xhigh" },
    },
  },
  gemini: {
    command: "gemini",
    args: [],
    models: {
      fast: { model: "gemini-2.5-flash", effort: "auto" },
      balanced: { model: "auto", effort: "auto" },
      deep: { model: "gemini-2.5-pro", effort: "auto" },
    },
  },
  copilot: {
    command: "copilot",
    args: [],
    models: {
      fast: { model: "claude-haiku-4.5", effort: "auto" },
      balanced: { model: "claude-sonnet-4.6", effort: "auto" },
      deep: { model: "gpt-5.3-codex", effort: "auto" },
    },
  },
  permissions: { mode: "prompt", networkAccess: true },
  history: {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.25,
    minimumSamples: 2,
    halfLifeDays: 90,
    explorationRate: 0,
    repositoryScoped: true,
  },
  logging: { level: "live", persist: true },
  orchestration: {
    mode: "auto",
    maxPhases: 6,
    autoReview: true,
    recoverOnFailure: true,
    stopOnFailure: false,
    outputTailChars: 5000,
  },
  rules: [],
};

const POLICIES = new Set<Policy>(["balanced", "claude-heavy", "codex-heavy"]);
const AGENTS = new Set<Agent>(["claude", "codex", "gemini", "copilot"]);

export function validPolicy(value: unknown): value is Policy {
  return typeof value === "string" && POLICIES.has(value as Policy);
}

export function validAgent(value: unknown): value is Agent {
  return typeof value === "string" && AGENTS.has(value as Agent);
}

export function configCandidates(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, ".airo.json"),
    path.join(cwd, ".ai-router.json"),
    path.join(os.homedir(), ".config", "airo", "config.json"),
    path.join(os.homedir(), ".config", "ai-router", "config.json"),
  ];
}

export function globalConfigPath(): string {
  return path.join(os.homedir(), ".config", "airo", "config.json");
}

function mergeProvider(base: RouterConfig["claude"], value: any): RouterConfig["claude"] {
  return {
    ...base,
    ...value,
    allowedModels: value?.allowedModels ?? base.allowedModels,
    models: {
      fast: { ...base.models.fast, ...value?.models?.fast },
      balanced: { ...base.models.balanced, ...value?.models?.balanced },
      deep: { ...base.models.deep, ...value?.models?.deep },
    },
  };
}

function mergeConfig(parsed: any, sourceFile?: string): RouterConfig {
  const config: RouterConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    policy: validPolicy(parsed.policy) ? parsed.policy : DEFAULT_CONFIG.policy,
    defaultAgent: validAgent(parsed.defaultAgent)
      ? parsed.defaultAgent
      : DEFAULT_CONFIG.defaultAgent,
    claude: mergeProvider(DEFAULT_CONFIG.claude, parsed.claude),
    codex: mergeProvider(DEFAULT_CONFIG.codex, parsed.codex),
    gemini: mergeProvider(DEFAULT_CONFIG.gemini, parsed.gemini),
    copilot: mergeProvider(DEFAULT_CONFIG.copilot, parsed.copilot),
    // Configurations written before model routing was introduced contain
    // deliberate model selections. Preserve those selections on upgrade.
    modelRouting: {
      mode: parsed.modelRouting?.mode === "dynamic" ? "dynamic" : "manual",
    },
    permissions: { ...DEFAULT_CONFIG.permissions, ...parsed.permissions },
    history: { ...DEFAULT_CONFIG.history, ...parsed.history },
    orchestration: { ...DEFAULT_CONFIG.orchestration, ...parsed.orchestration },
    logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
  };
  if (config.history.path && !path.isAbsolute(config.history.path) && sourceFile)
    config.history.path = path.resolve(path.dirname(sourceFile), config.history.path);
  return config;
}

export function loadConfig(cwd = process.cwd()): { config: RouterConfig; path?: string } {
  for (const file of configCandidates(cwd)) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      config: mergeConfig(parsed, file),
      path: file,
    };
  }
  return { config: DEFAULT_CONFIG };
}

/** Load only account-wide configuration, never a repository override. */
export function loadGlobalConfig(): { config: RouterConfig; path?: string } {
  const file = globalConfigPath();
  if (!fs.existsSync(file)) return { config: DEFAULT_CONFIG };
  return {
    config: mergeConfig(JSON.parse(fs.readFileSync(file, "utf8")), file),
    path: file,
  };
}

export function writeProjectConfig(cwd = process.cwd()): string {
  const file = path.join(cwd, ".airo.json");
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  fs.writeFileSync(
    file,
    JSON.stringify({ _comment: CONFIG_NOTE, ...DEFAULT_CONFIG }, null, 2) + "\n",
  );
  return file;
}

export function writeGlobalConfig(config: RouterConfig): string {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ _comment: CONFIG_NOTE, ...config }, null, 2) + "\n");
  return file;
}
