import { ROUTING_POLICY } from "./routing-policy.js";
import type { Agent, Effort, TaskFeatures } from "./types.js";

export interface ProviderCapabilities {
  accountInspection: boolean;
  effortControl: boolean;
  modelDiscovery: boolean;
  structuredProgress: boolean;
}

export interface ProviderDefinition {
  id: Agent;
  displayName: string;
  /** Stable tie-breaker after task-specific route scores. Lower values win. */
  fallbackPriority: number;
  capabilities: ProviderCapabilities;
}

/**
 * Source-controlled support registry. Adding a provider requires a reviewed
 * definition plus its config, runner, parser, discovery, and test coverage.
 */
export const PROVIDERS = [
  {
    id: "claude",
    displayName: "Claude Code",
    fallbackPriority: 0,
    capabilities: {
      accountInspection: true,
      effortControl: true,
      modelDiscovery: true,
      structuredProgress: true,
    },
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    fallbackPriority: 1,
    capabilities: {
      accountInspection: true,
      effortControl: true,
      modelDiscovery: true,
      structuredProgress: true,
    },
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    fallbackPriority: 2,
    capabilities: {
      accountInspection: false,
      effortControl: false,
      modelDiscovery: true,
      structuredProgress: true,
    },
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    fallbackPriority: 3,
    capabilities: {
      accountInspection: false,
      effortControl: false,
      modelDiscovery: true,
      structuredProgress: false,
    },
  },
] as const satisfies readonly ProviderDefinition[];

export const AGENTS: readonly Agent[] = PROVIDERS.map((provider) => provider.id);

export function providerDefinition(agent: Agent): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === agent)!;
}

export function effectiveEffort(agent: Agent, effort: Effort): Effort {
  return providerDefinition(agent).capabilities.effortControl ? effort : "auto";
}

export function routingCapabilityScore(
  agent: Agent,
  features: TaskFeatures,
): { points: number; reasons: string[] } {
  const profile = ROUTING_POLICY.providers[agent];
  const reasons: string[] = [];
  let points = profile.categories[features.category] ?? 0;
  if (points) reasons.push(`${features.category} capability`);
  if (features.risk === "high" && profile.highRiskBonus) {
    points += profile.highRiskBonus;
    reasons.push("high-risk capability");
  }
  if (features.complexity >= 4 && profile.deepComplexityBonus) {
    points += profile.deepComplexityBonus;
    reasons.push("complex-task capability");
  }
  if (features.category !== "general" && features.complexity <= 2 && profile.fastComplexityBonus) {
    points += profile.fastComplexityBonus;
    reasons.push("fast-task capability");
  }
  return { points, reasons };
}
