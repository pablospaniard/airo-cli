import os from "node:os";
import path from "node:path";
import type { Agent, RouterConfig } from "./types.js";
import { PROVIDERS } from "./providers.js";
import { readJson, readTomlValue, runProviderCommand } from "./provider-shell.js";
import { commandExists } from "./runner.js";

export interface ProviderAccount {
  agent: Agent;
  available: boolean;
  authenticated?: boolean;
  authMethod?: string;
  identity?: string;
  status: string;
  defaultModel?: string;
}

export interface ProviderAccountAdapter {
  /** Whether the provider exposes a deterministic authentication probe. */
  authInspection: boolean;
  detectDefaultModel: (config: RouterConfig, cwd: string) => string | undefined;
  inspect: (command: string, defaultModel?: string) => ProviderAccount;
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

function inspectWithoutAuthProbe(
  agent: Agent,
  command: string,
  defaultModel?: string,
): ProviderAccount {
  const available = commandExists(command);
  return {
    agent,
    available,
    authenticated: undefined,
    status: available ? "authentication not inspected" : `${command} not found in PATH`,
    defaultModel,
  };
}

function unprobedAccountAdapter(agent: Agent): ProviderAccountAdapter {
  return {
    authInspection: false,
    detectDefaultModel: (config) => config[agent].defaultModel,
    inspect: (command, defaultModel) => inspectWithoutAuthProbe(agent, command, defaultModel),
  };
}

export const PROVIDER_ACCOUNT_ADAPTERS: Record<Agent, ProviderAccountAdapter> = {
  claude: {
    authInspection: true,
    detectDefaultModel: (config, cwd) =>
      config.claude.defaultModel || process.env.ANTHROPIC_MODEL || claudeSettingsModel(cwd),
    inspect: inspectClaude,
  },
  codex: {
    authInspection: true,
    detectDefaultModel: (config) => {
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      return (
        config.codex.defaultModel || readTomlValue(path.join(codexHome, "config.toml"), "model")
      );
    },
    inspect: inspectCodex,
  },
  gemini: unprobedAccountAdapter("gemini"),
  copilot: unprobedAccountAdapter("copilot"),
};

export function providerAccountAdapter(agent: Agent): ProviderAccountAdapter {
  return PROVIDER_ACCOUNT_ADAPTERS[agent];
}

export function detectDefaultModels(
  config: RouterConfig,
  cwd = process.cwd(),
): Partial<Record<Agent, string>> {
  return Object.fromEntries(
    PROVIDERS.map(({ id }) => [id, providerAccountAdapter(id).detectDefaultModel(config, cwd)]),
  );
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
 * Inspect one provider account. Providers without a sign-in probe report an
 * explicit unknown state rather than being omitted or treated as signed out.
 */
export function inspectAccount(
  agent: Agent,
  config: RouterConfig,
  cwd = process.cwd(),
): ProviderAccount {
  const adapter = providerAccountAdapter(agent);
  return adapter.inspect(config[agent].command, adapter.detectDefaultModel(config, cwd));
}

export function inspectAccounts(config: RouterConfig, cwd = process.cwd()): ProviderAccount[] {
  return PROVIDERS.map((provider) => inspectAccount(provider.id, config, cwd));
}
