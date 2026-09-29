import type { Agent, ModelTier } from "../../types.js";

export interface RoutingPolicyCase {
  id: string;
  task: string;
  expectedAgent: Agent;
  expectedTier: ModelTier;
}

/**
 * Reviewed development corpus. These labels express intended cold-start
 * behavior and are not consumed by the production router.
 */
export const ROUTING_POLICY_CASES: readonly RoutingPolicyCase[] = [
  {
    id: "production-root-cause",
    task: "Investigate the root cause and architecture trade-offs in a production outage",
    expectedAgent: "claude",
    expectedTier: "deep",
  },
  {
    id: "security-audit",
    task: "Audit the authentication flow for security vulnerabilities",
    expectedAgent: "claude",
    expectedTier: "deep",
  },
  {
    id: "architecture-comparison",
    task: "Compare architecture options for this distributed cache",
    expectedAgent: "claude",
    expectedTier: "deep",
  },
  {
    id: "simple-unit-test",
    task: "Add a simple unit test for this type",
    expectedAgent: "codex",
    expectedTier: "fast",
  },
  {
    id: "localized-api-client",
    task: "Implement a small TypeScript API client in one file",
    expectedAgent: "codex",
    expectedTier: "fast",
  },
  {
    id: "endpoint-serializer",
    task: "Create a straightforward endpoint serializer",
    expectedAgent: "codex",
    expectedTier: "fast",
  },
  {
    id: "pull-request-review",
    task: "Review this pull request for regressions",
    expectedAgent: "claude",
    expectedTier: "fast",
  },
  {
    id: "legacy-migration",
    task: "Plan a migration of the legacy database API without breaking clients",
    expectedAgent: "claude",
    expectedTier: "deep",
  },
  {
    id: "intermittent-race",
    task: "Fix an intermittent race condition across modules",
    expectedAgent: "claude",
    expectedTier: "deep",
  },
  {
    id: "mechanical-rename",
    task: "Format and rename this interface in one file",
    expectedAgent: "codex",
    expectedTier: "fast",
  },
  {
    id: "offline-sync-research",
    task: "Research the best architecture for offline synchronization",
    expectedAgent: "claude",
    expectedTier: "deep",
  },
  {
    id: "payment-validation",
    task: "Build validation tests for the payment API",
    expectedAgent: "codex",
    expectedTier: "fast",
  },
];
