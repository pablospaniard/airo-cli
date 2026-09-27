import { PROVIDER_ACCOUNT_ADAPTERS } from "./account.js";
import { PROVIDER_CATALOG_ADAPTERS } from "./catalog.js";
import { PROVIDERS } from "./providers.js";
import { ROUTING_POLICY } from "./routing-policy.js";
import { PROVIDER_RUNTIME_ADAPTERS } from "./runner.js";
import type { Agent, RouterConfig } from "./types.js";

export const PROVIDER_SUPPORT_CONTRACT_VERSION = 1;

export type ProviderSupportCheckId =
  | "registry"
  | "configuration"
  | "routing-policy"
  | "runtime"
  | "failure-classification"
  | "account-inspection"
  | "model-discovery"
  | "capabilities"
  | "tests"
  | "documentation";

export interface ProviderSupportCheck {
  id: ProviderSupportCheckId;
  ready: boolean;
  detail: string;
}

export interface ProviderSupportStatus {
  agent: Agent;
  displayName: string;
  ready: boolean;
  checks: ProviderSupportCheck[];
}

export interface ProviderSupportAudit {
  contractVersion: number;
  ready: boolean;
  providers: ProviderSupportStatus[];
}

interface ProviderSupportEvidence {
  tests: readonly string[];
  documentation: readonly string[];
}

/**
 * Evidence that cannot be inferred from runtime objects. Keeping this map
 * exhaustive makes tests and docs an explicit part of adding a provider.
 */
export const PROVIDER_SUPPORT_EVIDENCE = {
  claude: {
    tests: ["src/test/providers.test.ts", "src/test/runner.test.ts"],
    documentation: ["README.md", "docs/routing-and-learning.md"],
  },
  codex: {
    tests: ["src/test/providers.test.ts", "src/test/runner.test.ts"],
    documentation: ["README.md", "docs/routing-and-learning.md"],
  },
  gemini: {
    tests: ["src/test/providers.test.ts", "src/test/runner.test.ts"],
    documentation: ["README.md", "docs/routing-and-learning.md"],
  },
  copilot: {
    tests: ["src/test/providers.test.ts", "src/test/runner.test.ts"],
    documentation: ["README.md", "docs/routing-and-learning.md"],
  },
} as const satisfies Record<Agent, ProviderSupportEvidence>;

function check(id: ProviderSupportCheckId, ready: boolean, detail: string): ProviderSupportCheck {
  return { id, ready, detail };
}

/** Source-level integration readiness. This does not imply a CLI is installed or signed in. */
export function auditProviderSupport(config: RouterConfig): ProviderSupportAudit {
  const priorities = PROVIDERS.map((provider) => provider.fallbackPriority);
  const fallbackOrderReady = new Set(priorities).size === PROVIDERS.length;
  const providers = PROVIDERS.map((provider): ProviderSupportStatus => {
    const configured = config[provider.id];
    const runtime = PROVIDER_RUNTIME_ADAPTERS[provider.id];
    const account = PROVIDER_ACCOUNT_ADAPTERS[provider.id];
    const catalog = PROVIDER_CATALOG_ADAPTERS[provider.id];
    const policy = ROUTING_POLICY.providers[provider.id];
    const evidence = PROVIDER_SUPPORT_EVIDENCE[provider.id];
    const modelTiersReady = ["fast", "balanced", "deep"].every((tier) =>
      Boolean(configured.models[tier as keyof typeof configured.models]?.model),
    );
    const checks = [
      check(
        "registry",
        Boolean(provider.id && provider.displayName) && fallbackOrderReady,
        `registered with fallback priority ${provider.fallbackPriority}`,
      ),
      check(
        "configuration",
        Boolean(configured.command) && modelTiersReady,
        "command and fast/balanced/deep model profiles",
      ),
      check("routing-policy", Boolean(policy), `policy ${ROUTING_POLICY.version}`),
      check(
        "runtime",
        typeof runtime.buildInvocation === "function" &&
          typeof runtime.parseProgress === "function",
        "invocation and progress/output/usage parsing",
      ),
      check(
        "failure-classification",
        typeof runtime.classifyFailure === "function",
        "provider-scoped authentication and usage-limit classification",
      ),
      check(
        "account-inspection",
        typeof account.inspect === "function" &&
          typeof account.detectDefaultModel === "function" &&
          account.authInspection === provider.capabilities.accountInspection,
        account.authInspection
          ? "deterministic authentication probe"
          : "explicit unknown auth state",
      ),
      check(
        "model-discovery",
        typeof catalog.probeLocal === "function" &&
          typeof catalog.contextInputs === "function" &&
          provider.capabilities.modelDiscovery,
        "local discovery with configured tier fallback",
      ),
      check(
        "capabilities",
        Object.values(provider.capabilities).every((value) => typeof value === "boolean"),
        "reviewed routing and runtime capability metadata",
      ),
      check("tests", evidence.tests.length > 0, evidence.tests.join(", ")),
      check("documentation", evidence.documentation.length > 0, evidence.documentation.join(", ")),
    ];
    return {
      agent: provider.id,
      displayName: provider.displayName,
      ready: checks.every((item) => item.ready),
      checks,
    };
  });
  return {
    contractVersion: PROVIDER_SUPPORT_CONTRACT_VERSION,
    ready: providers.every((provider) => provider.ready),
    providers,
  };
}
