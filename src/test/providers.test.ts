import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_ACCOUNT_ADAPTERS, providerAccountAdapter } from "../account.js";
import { PROVIDER_CATALOG_ADAPTERS, providerCatalogAdapter } from "../catalog.js";
import { DEFAULT_CONFIG } from "../config.js";
import {
  AGENTS,
  PROVIDERS,
  effectiveEffort,
  providerDefinition,
  routingCapabilityScore,
} from "../providers.js";
import { ROUTING_POLICY } from "../routing-policy.js";
import {
  PROVIDER_RUNTIME_ADAPTERS,
  buildProviderInvocation,
  diagnosticInvocationArgs,
  providerRuntimeAdapter,
} from "../runner.js";
import { routeTask } from "../router.js";

test("defines every supported provider exactly once", () => {
  assert.deepEqual(AGENTS, ["claude", "codex", "gemini", "copilot"]);
  assert.equal(new Set(AGENTS).size, AGENTS.length);
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.fallbackPriority),
    [0, 1, 2, 3],
  );
});

test("records provider capabilities used by generic policy", () => {
  assert.equal(providerDefinition("claude").capabilities.accountInspection, true);
  assert.equal(providerDefinition("codex").capabilities.effortControl, true);
  assert.equal(providerDefinition("gemini").capabilities.accountInspection, false);
  assert.equal(providerDefinition("copilot").capabilities.structuredProgress, false);
  assert.equal(effectiveEffort("claude", "high"), "high");
  assert.equal(effectiveEffort("codex", "xhigh"), "xhigh");
  assert.equal(effectiveEffort("gemini", "high"), "auto");
  assert.equal(effectiveEffort("copilot", "high"), "auto");
});

test("requires every registered provider to have complete adapter coverage", () => {
  assert.deepEqual(Object.keys(PROVIDER_RUNTIME_ADAPTERS), [...AGENTS]);
  assert.deepEqual(Object.keys(PROVIDER_ACCOUNT_ADAPTERS), [...AGENTS]);
  assert.deepEqual(Object.keys(PROVIDER_CATALOG_ADAPTERS), [...AGENTS]);
  assert.deepEqual(Object.keys(ROUTING_POLICY.providers), [...AGENTS]);

  for (const provider of PROVIDERS) {
    const configured = DEFAULT_CONFIG[provider.id];
    const runtimeAdapter = providerRuntimeAdapter(provider.id);
    const accountAdapter = providerAccountAdapter(provider.id);
    const catalogAdapter = providerCatalogAdapter(provider.id);
    assert.ok(configured.command);
    assert.deepEqual(Object.keys(configured.models), ["fast", "balanced", "deep"]);
    assert.equal(typeof runtimeAdapter.buildInvocation, "function");
    assert.equal(typeof runtimeAdapter.parseProgress, "function");
    assert.equal(typeof accountAdapter.detectDefaultModel, "function");
    assert.equal(typeof accountAdapter.inspect, "function");
    assert.equal(accountAdapter.authInspection, provider.capabilities.accountInspection);
    assert.equal(typeof catalogAdapter.probeLocal, "function");
    assert.equal(typeof catalogAdapter.contextInputs, "function");
    assert.equal(provider.capabilities.modelDiscovery, true);
  }
});

test("runtime adapters identify the prompt argument for safe diagnostics", () => {
  const prompt = "private task text";
  for (const agent of AGENTS) {
    const route = routeTask("neutral routing task", DEFAULT_CONFIG);
    route.agent = agent;
    route.model = DEFAULT_CONFIG[agent].models.balanced.model;
    const invocation = buildProviderInvocation(route, prompt, DEFAULT_CONFIG, {
      headless: true,
      structuredProgress: true,
    });

    assert.equal(invocation.args[invocation.promptArgIndex], prompt);
    assert.equal(invocation.args.filter((arg) => arg === prompt).length, 1);
    assert.equal(diagnosticInvocationArgs(invocation).includes(prompt), false);
    assert.equal(
      diagnosticInvocationArgs(invocation)[invocation.promptArgIndex],
      `<prompt:${prompt.length} chars>`,
    );
  }
});

test("scores semantic task features through provider capability profiles", () => {
  const features = {
    category: "research" as const,
    risk: "high" as const,
    complexity: 5,
    tokens: [],
    embedding: [],
  };

  assert.deepEqual(routingCapabilityScore("claude", features), {
    points: 6,
    reasons: ["research capability", "high-risk capability", "complex-task capability"],
  });
  assert.equal(routingCapabilityScore("codex", features).points, 0);
  assert.equal(routingCapabilityScore("gemini", features).points, 4);
});
