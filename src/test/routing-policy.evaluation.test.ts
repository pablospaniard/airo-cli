import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { routeTask } from "../router.js";
import { ROUTING_POLICY } from "../routing-policy.js";
import { ROUTING_POLICY_CASES } from "./fixtures/routing-policy-cases.js";

test("versioned routing policy meets the reviewed cold-start evaluation gate", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.history.enabled = false;
  config.history.learningEnabled = false;

  const results = ROUTING_POLICY_CASES.map((fixture) => ({
    fixture,
    route: routeTask(fixture.task, config),
  }));
  const providerMatches = results.filter(
    ({ fixture, route }) => route.agent === fixture.expectedAgent,
  ).length;
  const tierMatches = results.filter(
    ({ fixture, route }) => route.modelTier === fixture.expectedTier,
  ).length;
  const jointMatches = results.filter(
    ({ fixture, route }) =>
      route.agent === fixture.expectedAgent && route.modelTier === fixture.expectedTier,
  ).length;
  const count = results.length;
  const failures = results
    .filter(
      ({ fixture, route }) =>
        route.agent !== fixture.expectedAgent || route.modelTier !== fixture.expectedTier,
    )
    .map(
      ({ fixture, route }) =>
        `${fixture.id}: expected ${fixture.expectedAgent}/${fixture.expectedTier}, received ${route.agent}/${route.modelTier}`,
    );

  assert.equal(ROUTING_POLICY.schemaVersion, 1);
  assert.match(ROUTING_POLICY.version, /^\d+\.\d+\.\d+$/);
  assert.equal(new Set(ROUTING_POLICY_CASES.map(({ id }) => id)).size, count);
  assert.ok(providerMatches / count >= 0.9, failures.join("\n"));
  assert.ok(tierMatches / count >= 0.9, failures.join("\n"));
  assert.ok(jointMatches / count >= 0.85, failures.join("\n"));
  assert.ok(results.every(({ route }) => route.routingPolicyVersion === ROUTING_POLICY.version));
});
