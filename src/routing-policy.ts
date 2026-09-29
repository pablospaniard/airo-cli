import type { Agent, Policy, TaskCategory } from "./types.js";

export interface ProviderRoutingProfile {
  categories: Partial<Record<TaskCategory, number>>;
  highRiskBonus: number;
  deepComplexityBonus: number;
  fastComplexityBonus: number;
}

export interface RoutingPolicyArtifact {
  schemaVersion: 1;
  version: string;
  providers: Record<Agent, ProviderRoutingProfile>;
  tierSuitability: {
    exact: number;
    adjacent: number;
    distant: number;
    fastMaxComplexity: number;
    balancedComplexity: number;
  };
  configuredBiases: Record<Policy, Partial<Record<Agent, number>>>;
  complexity: {
    base: number;
    longTaskWords: number;
    veryLongTaskWords: number;
    compoundSignals: number;
  };
}

/**
 * Reviewed cold-start routing policy shipped with AIRO. Production learning
 * adds bounded local evidence at runtime; it never rewrites this artifact.
 */
export const ROUTING_POLICY: RoutingPolicyArtifact = {
  schemaVersion: 1,
  version: "1.0.0",
  providers: {
    claude: {
      categories: { debug: 3, research: 3, review: 2 },
      highRiskBonus: 2,
      deepComplexityBonus: 1,
      fastComplexityBonus: 0,
    },
    codex: {
      categories: { implement: 3, test: 3, debug: 1 },
      highRiskBonus: 0,
      deepComplexityBonus: 0,
      fastComplexityBonus: 1,
    },
    gemini: {
      categories: { research: 2, review: 1 },
      highRiskBonus: 1,
      deepComplexityBonus: 1,
      fastComplexityBonus: 0,
    },
    copilot: {
      categories: { implement: 2, test: 2, review: 1 },
      highRiskBonus: 0,
      deepComplexityBonus: 0,
      fastComplexityBonus: 1,
    },
  },
  tierSuitability: {
    exact: 2,
    adjacent: 0,
    distant: -1,
    fastMaxComplexity: 2,
    balancedComplexity: 3,
  },
  configuredBiases: {
    balanced: {},
    "claude-heavy": { claude: 2 },
    "codex-heavy": { codex: 2 },
  },
  complexity: {
    base: 2,
    longTaskWords: 20,
    veryLongTaskWords: 55,
    compoundSignals: 3,
  },
};
