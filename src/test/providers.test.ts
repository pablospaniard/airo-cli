import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENTS,
  PROVIDERS,
  effectiveEffort,
  providerDefinition,
  routingCapabilityScore,
} from "../providers.js";

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
