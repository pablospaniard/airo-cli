import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { routeTask } from "../router.js";
import { ROUTING_POLICY } from "../routing-policy.js";
import {
  ROUTING_POLICY_CALIBRATION_CASES,
  ROUTING_POLICY_CASES,
  ROUTING_POLICY_DATASET,
  ROUTING_POLICY_HELD_OUT_CASES,
} from "./fixtures/routing-policy-cases.js";

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

test("keeps a synthetic privacy-reviewed held-out corpus separate from calibration", () => {
  assert.equal(ROUTING_POLICY_DATASET.schemaVersion, 1);
  assert.equal(ROUTING_POLICY_DATASET.provenance, "synthetic");
  assert.equal(ROUTING_POLICY_DATASET.privacyReview.status, "approved");
  assert.ok(ROUTING_POLICY_CALIBRATION_CASES.length >= 10);
  assert.ok(ROUTING_POLICY_HELD_OUT_CASES.length >= 8);
  assert.ok(ROUTING_POLICY_CALIBRATION_CASES.every((item) => item.split === "calibration"));
  assert.ok(ROUTING_POLICY_HELD_OUT_CASES.every((item) => item.split === "held-out"));
  const calibrationIds = new Set(ROUTING_POLICY_CALIBRATION_CASES.map((item) => item.id));
  assert.ok(ROUTING_POLICY_HELD_OUT_CASES.every((item) => !calibrationIds.has(item.id)));
  for (const fixture of ROUTING_POLICY_CASES) {
    assert.doesNotMatch(fixture.task, /(?:https?:\/\/|\/Users\/|[\w.+-]+@[\w.-]+|api[_-]?key)/i);
    assert.doesNotMatch(fixture.task, /(?:sk-[a-z0-9]{12,}|ghp_[a-z0-9]{12,})/i);
  }
});
