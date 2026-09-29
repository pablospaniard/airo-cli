import assert from "node:assert/strict";
import fs from "node:fs";
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
  PROVIDER_SUPPORT_CONTRACT_VERSION,
  PROVIDER_SUPPORT_EVIDENCE,
  auditProviderSupport,
} from "../provider-support.js";
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
    assert.equal(typeof runtimeAdapter.classifyFailure, "function");
    assert.equal(typeof accountAdapter.detectDefaultModel, "function");
    assert.equal(typeof accountAdapter.inspect, "function");
    assert.equal(accountAdapter.authInspection, provider.capabilities.accountInspection);
    assert.equal(typeof catalogAdapter.probeLocal, "function");
    assert.equal(typeof catalogAdapter.contextInputs, "function");
    assert.equal(provider.capabilities.modelDiscovery, true);
  }
});

test("passes the versioned provider support gate for every registered provider", () => {
  const audit = auditProviderSupport(DEFAULT_CONFIG);

  assert.equal(PROVIDER_SUPPORT_CONTRACT_VERSION, 1);
  assert.equal(audit.ready, true);
  assert.deepEqual(
    audit.providers.map((provider) => provider.agent),
    [...AGENTS],
  );
  assert.deepEqual(Object.keys(PROVIDER_SUPPORT_EVIDENCE), [...AGENTS]);
  for (const provider of audit.providers) {
    assert.equal(provider.ready, true);
    assert.equal(provider.checks.length, 10);
    assert.equal(
      provider.checks.every((check) => check.ready),
      true,
    );
    for (const file of [
      ...PROVIDER_SUPPORT_EVIDENCE[provider.agent].tests,
      ...PROVIDER_SUPPORT_EVIDENCE[provider.agent].documentation,
    ])
      assert.equal(
        fs.existsSync(file),
        true,
        `${provider.agent} support evidence is missing: ${file}`,
      );
  }
});

test("reports incomplete provider configuration instead of claiming support", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.gemini.command = "";

  const audit = auditProviderSupport(config);
  const gemini = audit.providers.find((provider) => provider.agent === "gemini")!;

  assert.equal(audit.ready, false);
  assert.equal(gemini.ready, false);
  assert.equal(gemini.checks.find((check) => check.id === "configuration")?.ready, false);
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
