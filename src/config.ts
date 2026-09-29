import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { withFileLock } from "./file-lock.js";
import { dataRootDir } from "./paths.js";
import type { Agent, Effort, ModelTier, Policy, RouterConfig, Rule } from "./types.js";

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
const AGENT_IDS = new Set<Agent>(["claude", "codex", "gemini", "copilot"]);
const MODEL_TIERS = new Set<ModelTier>(["fast", "balanced", "deep"]);
const EFFORTS = new Set<Effort>(["auto", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function validPolicy(value: unknown): value is Policy {
  return typeof value === "string" && POLICIES.has(value as Policy);
}

export function validAgent(value: unknown): value is Agent {
  return typeof value === "string" && AGENT_IDS.has(value as Agent);
}

export function validModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && MODEL_TIERS.has(value as ModelTier);
}

export function validEffort(value: unknown): value is Effort {
  return typeof value === "string" && EFFORTS.has(value as Effort);
}

function normalizedRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const rule = candidate as Record<string, unknown>;
    if (typeof rule.name !== "string" || typeof rule.pattern !== "string") return [];
    return [
      {
        name: rule.name,
        pattern: rule.pattern,
        ...(validAgent(rule.agent) ? { agent: rule.agent } : {}),
        ...(validModelTier(rule.modelTier) ? { modelTier: rule.modelTier } : {}),
        ...(validEffort(rule.effort) ? { effort: rule.effort } : {}),
      },
    ];
  });
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
    rules: normalizedRules(parsed.rules),
  };
  if (config.history.path && !path.isAbsolute(config.history.path) && sourceFile)
    config.history.path = path.resolve(path.dirname(sourceFile), config.history.path);
  return config;
}

export function loadConfig(cwd = process.cwd()): { config: RouterConfig; path?: string } {
  for (const file of configCandidates(cwd)) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { config: mergeConfig(parsed, file), path: file };
  }
  return { config: DEFAULT_CONFIG };
}

/** Load only account-wide configuration, never a repository override. */
export function loadGlobalConfig(): { config: RouterConfig; path?: string } {
  const file = globalConfigPath();
  const readable = fs.existsSync(file)
    ? file
    : fs.existsSync(`${file}.update`)
      ? `${file}.update`
      : undefined;
  if (!readable) return { config: DEFAULT_CONFIG };
  return {
    config: mergeConfig(JSON.parse(fs.readFileSync(readable, "utf8")), file),
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
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ _comment: CONFIG_NOTE, ...config }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
  return file;
}

export function updateGlobalConfig(mutate: (config: RouterConfig) => RouterConfig): RouterConfig {
  return withFileLock(path.join(dataRootDir(), "global-config.lock"), () => {
    const file = globalConfigPath();
    const recovery = `${file}.update`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(recovery)) {
      if (!fs.existsSync(file)) fs.linkSync(recovery, file);
      fs.unlinkSync(recovery);
    }
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    const current = before
      ? mergeConfig(JSON.parse(before), file)
      : structuredClone(DEFAULT_CONFIG);
    const next = mutate(current);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ _comment: CONFIG_NOTE, ...next }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    let captured = false;
    try {
      if (before === undefined) {
        try {
          fs.linkSync(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          throw new Error(
            `${file} changed on disk while it was being updated; no changes were written.`,
          );
        }
      } else {
        fs.renameSync(file, recovery);
        captured = true;
        if (fs.readFileSync(recovery, "utf8") !== before)
          throw new Error(
            `${file} changed on disk while it was being updated; no changes were written.`,
          );
        try {
          fs.linkSync(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          throw new Error(
            `${file} changed on disk while it was being updated; no changes were written.`,
          );
        }
      }
      return next;
    } finally {
      if (captured && !fs.existsSync(file))
        try {
          fs.linkSync(recovery, file);
        } catch {}
      try {
        fs.unlinkSync(recovery);
      } catch {}
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  });
}
