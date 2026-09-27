import type { Agent, Effort, TaskCategory, TaskFeatures } from "./types.js";

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
  routing: {
    categories: Partial<Record<TaskCategory, number>>;
    highRiskBonus: number;
    deepComplexityBonus: number;
    fastComplexityBonus: number;
  };
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
    routing: {
      categories: { debug: 3, research: 3, review: 2 },
      highRiskBonus: 2,
      deepComplexityBonus: 1,
      fastComplexityBonus: 0,
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
    routing: {
      categories: { implement: 3, test: 3, debug: 1 },
      highRiskBonus: 0,
      deepComplexityBonus: 0,
      fastComplexityBonus: 1,
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
    routing: {
      categories: { research: 2, review: 1 },
      highRiskBonus: 1,
      deepComplexityBonus: 1,
      fastComplexityBonus: 0,
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
    routing: {
      categories: { implement: 2, test: 2, review: 1 },
      highRiskBonus: 0,
      deepComplexityBonus: 0,
      fastComplexityBonus: 1,
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
  const profile = providerDefinition(agent).routing;
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
