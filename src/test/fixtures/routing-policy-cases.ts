import type { Agent, ModelTier } from "../../types.js";

export interface RoutingPolicyCase {
  id: string;
  task: string;
  expectedAgent: Agent;
  expectedTier: ModelTier;
  split: "calibration" | "held-out";
}

export const ROUTING_POLICY_DATASET = {
  schemaVersion: 1,
  version: "1.0.0",
  provenance: "synthetic",
  privacyReview: {
    version: "1.0.0",
    status: "approved",
    excludes: [
      "source code",
      "repository names and paths",
      "credentials and secrets",
      "personal data",
      "provider output",
    ],
  },
} as const;

/**
 * Reviewed development corpus. These labels express intended cold-start
 * behavior and are not consumed by the production router.
 */
export const ROUTING_POLICY_CALIBRATION_CASES: readonly RoutingPolicyCase[] = [
  {
    id: "production-root-cause",
    task: "Investigate the root cause and architecture trade-offs in a production outage",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "calibration",
  },
  {
    id: "security-audit",
    task: "Audit the authentication flow for security vulnerabilities",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "calibration",
  },
  {
    id: "architecture-comparison",
    task: "Compare architecture options for this distributed cache",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "calibration",
  },
  {
    id: "simple-unit-test",
    task: "Add a simple unit test for this type",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "calibration",
  },
  {
    id: "localized-api-client",
    task: "Implement a small TypeScript API client in one file",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "calibration",
  },
  {
    id: "endpoint-serializer",
    task: "Create a straightforward endpoint serializer",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "calibration",
  },
  {
    id: "pull-request-review",
    task: "Review this pull request for regressions",
    expectedAgent: "claude",
    expectedTier: "fast",
    split: "calibration",
  },
  {
    id: "legacy-migration",
    task: "Plan a migration of the legacy database API without breaking clients",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "calibration",
  },
  {
    id: "intermittent-race",
    task: "Fix an intermittent race condition across modules",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "calibration",
  },
  {
    id: "mechanical-rename",
    task: "Format and rename this interface in one file",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "calibration",
  },
  {
    id: "offline-sync-research",
    task: "Research the best architecture for offline synchronization",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "calibration",
  },
  {
    id: "payment-validation",
    task: "Build validation tests for the payment API",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "calibration",
  },
];

/** Held-out cases are measured by the development evaluator, never used as calibration inputs. */
export const ROUTING_POLICY_HELD_OUT_CASES: readonly RoutingPolicyCase[] = [
  {
    id: "heldout-data-loss-incident",
    task: "Investigate a distributed production incident that may have caused data loss",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "held-out",
  },
  {
    id: "heldout-parser-test",
    task: "Add a focused unit test for a small parser helper",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "held-out",
  },
  {
    id: "heldout-threat-review",
    task: "Review the encryption design and threat model for security gaps",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "held-out",
  },
  {
    id: "heldout-json-converter",
    task: "Implement a simple JSON converter in one TypeScript file",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "held-out",
  },
  {
    id: "heldout-cache-research",
    task: "Research architecture options for a resilient multi-region cache",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "held-out",
  },
  {
    id: "heldout-documentation-review",
    task: "Review a small documentation change for mistakes",
    expectedAgent: "claude",
    expectedTier: "fast",
    split: "held-out",
  },
  {
    id: "heldout-validation-test",
    task: "Write straightforward validation tests for a request mapper",
    expectedAgent: "codex",
    expectedTier: "fast",
    split: "held-out",
  },
  {
    id: "heldout-deadlock-debug",
    task: "Debug an intermittent cross-module deadlock in a production service",
    expectedAgent: "claude",
    expectedTier: "deep",
    split: "held-out",
  },
];

export const ROUTING_POLICY_CASES: readonly RoutingPolicyCase[] = [
  ...ROUTING_POLICY_CALIBRATION_CASES,
  ...ROUTING_POLICY_HELD_OUT_CASES,
];
