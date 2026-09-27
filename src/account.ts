import os from "node:os";
import path from "node:path";
import type { Agent, RouterConfig } from "./types.js";
import { PROVIDERS } from "./providers.js";
import { readJson, readTomlValue, runProviderCommand } from "./provider-shell.js";

export interface ProviderAccount {
  agent: Agent;
  available: boolean;
  authenticated: boolean;
  authMethod?: string;
  identity?: string;
  status: string;
  defaultModel?: string;
}

/**
 * `Not logged in` contains `logged in`, so a plain match reports an
 * unauthenticated provider as ready. Check the negation first.
 */
function isNegatedSignIn(output: string): boolean {
  return /\b(?:not|never|isn'?t|aren'?t)\s+(?:currently\s+)?(?:logged\s*in|signed\s*in|authenticated)\b|\bno\s+(?:active\s+)?(?:account|credentials|session)\b/i.test(
    output,
  );
}

function claudeSettingsModel(cwd: string): string | undefined {
  const files = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
  let model: string | undefined;
  for (const file of files) {
    const value = readJson(file)?.model;
    if (typeof value === "string" && value.trim()) model = value.trim();
  }
  return model;
}

export function detectDefaultModels(
  config: RouterConfig,
  cwd = process.cwd(),
): Partial<Record<Agent, string>> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    claude: config.claude.defaultModel || process.env.ANTHROPIC_MODEL || claudeSettingsModel(cwd),
    codex: config.codex.defaultModel || readTomlValue(path.join(codexHome, "config.toml"), "model"),
    gemini: config.gemini.defaultModel,
    copilot: config.copilot.defaultModel,
  };
}

function inspectClaude(command: string, defaultModel?: string): ProviderAccount {
  const checked = runProviderCommand(command, ["auth", "status"]);
  if (!checked.result)
    return {
      agent: "claude",
      available: false,
      authenticated: false,
      status: checked.error ?? `${command} not found in PATH`,
      defaultModel,
    };
  const result = checked.result;
  if (result.error)
    return {
      agent: "claude",
      available: false,
      authenticated: false,
      status: result.error.message,
      defaultModel,
    };
  const output = (result.stdout || result.stderr || "").trim();
  const parsed = (() => {
    try {
      return JSON.parse(output);
    } catch {
      return undefined;
    }
  })();
  const authenticated = parsed
    ? Boolean(parsed.loggedIn)
    : result.status === 0 && !isNegatedSignIn(output) && /logged\s*in|authenticated/i.test(output);
  const identity = parsed?.emailAddress ?? parsed?.email ?? parsed?.account?.email;
  const authMethod = parsed?.authMethod ?? parsed?.subscriptionType;
  return {
    agent: "claude",
    available: true,
    authenticated,
    authMethod,
    identity: typeof identity === "string" ? identity : undefined,
    status: authenticated ? "authenticated" : "not authenticated",
    defaultModel,
  };
}

function inspectCodex(command: string, defaultModel?: string): ProviderAccount {
  const checked = runProviderCommand(command, ["login", "status"]);
  if (!checked.result)
    return {
      agent: "codex",
      available: false,
      authenticated: false,
      status: checked.error ?? `${command} not found in PATH`,
      defaultModel,
    };
  const result = checked.result;
  if (result.error)
    return {
      agent: "codex",
      available: false,
      authenticated: false,
      status: result.error.message,
      defaultModel,
    };
  const output = (result.stdout || result.stderr || "").trim();
  const authenticated =
    result.status === 0 && !isNegatedSignIn(output) && /logged in/i.test(output);
  const method = output.match(/logged in using\s+(.+)/i)?.[1]?.trim();
  return {
    agent: "codex",
    available: true,
    authenticated,
    authMethod: method,
    status: authenticated ? "authenticated" : output || `status command exited ${result.status}`,
    defaultModel,
  };
}

/**
 * Inspect one provider account. Returns undefined for providers without a
 * sign-in probe, so callers can treat them as "unknown" rather than broken.
 */
export function inspectAccount(
  agent: Agent,
  config: RouterConfig,
  cwd = process.cwd(),
): ProviderAccount | undefined {
  const defaults = detectDefaultModels(config, cwd);
  if (agent === "claude") return inspectClaude(config.claude.command, defaults.claude);
  if (agent === "codex") return inspectCodex(config.codex.command, defaults.codex);
  return undefined;
}

export function inspectAccounts(config: RouterConfig, cwd = process.cwd()): ProviderAccount[] {
  return PROVIDERS.filter((provider) => provider.capabilities.accountInspection)
    .map((provider) => inspectAccount(provider.id, config, cwd))
    .filter((account): account is ProviderAccount => Boolean(account));
}
