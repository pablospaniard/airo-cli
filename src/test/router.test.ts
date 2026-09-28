import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { appendHistory } from "../history.js";
import { ROUTING_POLICY } from "../routing-policy.js";
import {
  applyRoutePreferences,
  applyRouteOverrides,
  applyPhasePreference,
  fallbackIfMissing,
  fallbackProvider,
  needsRecovery,
  planPhases,
  shouldOrchestrate,
} from "../orchestrator.js";
import {
  agentForModel,
  generateRouteCandidates,
  requestedModel,
  requestedModelTier,
  routeTask,
  routingClarification,
  userRoutingRequest,
} from "../router.js";
import type { RouterConfig } from "../types.js";

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

test("routes architecture investigations to Claude with a deep model", () => {
  const route = routeTask("Investigate the root cause and architecture trade-offs", config());

  assert.equal(route.agent, "claude");
  assert.equal(route.modelTier, "deep");
  assert.equal(route.model, DEFAULT_CONFIG.claude.models.deep.model);
  assert.ok(route.claudeScore > route.codexScore);
  assert.equal(route.routingPolicyVersion, ROUTING_POLICY.version);
});

test("defensively ignores an unknown routing policy", () => {
  const invalid = config() as unknown as { policy: string };
  invalid.policy = "gemini-heavy";
  assert.doesNotThrow(() => routeTask("Fix a parser bug", invalid as RouterConfig));
});

test("routes a small test implementation to Codex with a fast model", () => {
  const route = routeTask("Add a unit test for this simple type", config());

  assert.equal(route.agent, "codex");
  assert.equal(route.modelTier, "fast");
  assert.equal(route.model, DEFAULT_CONFIG.codex.models.fast.model);
  assert.ok(route.reasons.some((reason) => /test capability/.test(reason.reason)));
});

test("generates and scores every registered provider and tier candidate", () => {
  const current = config();
  const scores = { claude: 4, codex: 2, gemini: 1, copilot: 0 };
  const candidates = generateRouteCandidates(current, scores, 5);

  assert.equal(candidates.length, 12);
  assert.deepEqual(
    new Set(candidates.map((candidate) => candidate.agent)),
    new Set(["claude", "codex", "gemini", "copilot"]),
  );
  assert.equal(
    candidates.find((candidate) => candidate.agent === "claude" && candidate.modelTier === "deep")
      ?.totalScore,
    6,
  );
  assert.equal(
    candidates.find((candidate) => candidate.agent === "gemini" && candidate.modelTier === "deep")
      ?.effort,
    "auto",
  );
});

test("falls back across every registered provider using route scores", () => {
  const current = config();
  current.claude.command = "/missing/claude";
  current.codex.command = "/missing/codex";
  current.gemini.command = process.execPath;
  current.copilot.command = process.execPath;
  const route = routeTask("Investigate an architecture regression", current);
  route.agentScores = { claude: 10, codex: 8, gemini: 3, copilot: 5 };

  const fallback = fallbackIfMissing(route, current);

  assert.equal(fallback.agent, "copilot");
  assert.equal(fallback.model, current.copilot.models.deep.model);
  assert.match(fallback.modelReasons.at(-1)!, /fallback copilot/);
});

test("skips a signed-out fallback and continues through the provider registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-generic-fallback-"));
  const signedOut = path.join(dir, "signed-out-codex");
  fs.writeFileSync(signedOut, "#!/bin/sh\nprintf 'Not logged in'\n");
  fs.chmodSync(signedOut, 0o755);
  try {
    const current = config();
    current.codex.command = signedOut;
    current.gemini.command = process.execPath;
    current.copilot.command = "/missing/copilot";
    const route = routeTask("Investigate an architecture regression", current);
    route.agentScores = { claude: 10, codex: 8, gemini: 5, copilot: 3 };
    const ruledOut = new Set<RouterConfig["defaultAgent"]>();

    const fallback = fallbackProvider(route, current, "authentication", ruledOut);

    assert.equal(fallback?.agent, "gemini");
    assert.equal(ruledOut.has("codex"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("honors an explicit request for the most powerful model", () => {
  const current = config();
  const task = "use most powerfull model and review again";
  const route = routeTask(task, current);
  const review = planPhases(task, current)[0];
  const phaseRoute = applyPhasePreference(route, review, current);

  assert.equal(requestedModelTier(task), "deep");
  assert.equal(phaseRoute.userRequestedTier, "deep");
  assert.equal(phaseRoute.modelTier, "deep");
  assert.equal(phaseRoute.model, current.claude.models.deep.model);
  assert.equal(phaseRoute.effort, current.claude.models.deep.effort);
});

test("does not mistake a negative model instruction for a deep-tier request", () => {
  assert.equal(requestedModelTier("do not use the most powerful model"), undefined);
});

test("routes explicit models outside the automatic tier defaults", () => {
  const current = config();
  const codex = routeTask("use gpt-6-astra and tell me the time", current);
  const claude = routeTask("please use claude-opus-5 for this review", current);

  assert.deepEqual(requestedModel("use gpt-6-astra", current), {
    agent: "codex",
    model: "gpt-6-astra",
  });
  assert.equal(agentForModel("sonnet", current), "claude");
  assert.equal(agentForModel("o3", current), "codex");
  assert.equal(agentForModel("gpt-4.1", current), "codex");
  assert.equal(agentForModel("claude-haiku-4.5", current), "copilot");
  assert.equal(agentForModel("gpt-5.3-codex", current), "copilot");
  assert.equal(agentForModel("unknown-model", current), undefined);
  assert.equal(requestedModel("use GPT for this task", current), undefined);
  assert.equal(codex.agent, "codex");
  assert.equal(codex.model, "gpt-6-astra");
  assert.equal(codex.userRequestedModel, "gpt-6-astra");
  assert.equal(claude.agent, "claude");
  assert.equal(claude.model, "claude-opus-5");
});

test("understands human-style provider, model, and tier overrides", () => {
  const current = config();
  const opus = routeTask("switch to use Claude Opus model, then review the PR", current);
  const gemini = routeTask("go with Gemini on the fast tier for this", current);
  const codex = routeTask("please run it with Codex deep", current);

  assert.equal(opus.agent, "claude");
  assert.equal(opus.modelTier, "deep");
  assert.equal(opus.model, current.claude.models.deep.model);
  assert.equal(gemini.agent, "gemini");
  assert.equal(gemini.modelTier, "fast");
  assert.equal(gemini.model, current.gemini.models.fast.model);
  assert.equal(gemini.effort, "auto");
  assert.equal(codex.agent, "codex");
  assert.equal(codex.modelTier, "deep");
  assert.equal(codex.model, current.codex.models.deep.model);
});

test("normalizes unsupported provider effort overrides", () => {
  const current = config();
  const route = applyRouteOverrides(
    routeTask("implement this endpoint", current),
    {
      agent: "copilot",
      tier: "deep",
      effort: "high",
    },
    current,
  );

  assert.equal(route.agent, "copilot");
  assert.equal(route.effort, "auto");
});

test("pins the provider only when the user chose it", () => {
  const current = config();

  assert.equal(routeTask("go with Gemini on the fast tier for this", current).agentPinned, true);
  assert.equal(routeTask("use gpt-6-astra and tell me the time", current).agentPinned, true);
  assert.equal(routeTask("review this pull request", current).agentPinned, false);
  assert.equal(
    applyRouteOverrides(routeTask("review this pull request", current), { agent: "codex" }, current)
      .agentPinned,
    true,
  );
  assert.equal(
    applyRoutePreferences(
      routeTask("review this pull request", current),
      { agent: "codex" },
      current,
    ).agentPinned,
    true,
  );
  assert.equal(
    applyRouteOverrides(routeTask("review this pull request", current), { tier: "fast" }, current)
      .agentPinned,
    false,
  );
});

test("lets an on-demand model request override persistent routing preferences", () => {
  const current = config();
  const route = applyRoutePreferences(
    routeTask("use codex 5.6 terra", current),
    { agent: "codex", tier: "fast" },
    current,
  );

  assert.equal(route.agent, "codex");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.model, "gpt-5.6-terra");
  assert.equal(route.userRequestedTier, "balanced");
});

test("applies persistent preferences after automatic phase choices", () => {
  const current = config();
  const task = "review this pull request";
  const route = applyRoutePreferences(
    applyPhasePreference(routeTask(task, current), planPhases(task, current)[0], current),
    { agent: "codex", tier: "fast" },
    current,
  );

  assert.equal(route.agent, "codex");
  assert.equal(route.modelTier, "fast");
  assert.equal(route.model, current.codex.models.fast.model);
});

test("uses the newest routing instruction and ignores stale session choices", () => {
  const current = config();
  const request = userRoutingRequest(
    "Earlier request: fix all, use gpt-5.6-sol model\nCurrent follow-up: switch to Claude Opus model",
    current,
  );

  assert.equal(request.agent, "claude");
  assert.equal(request.model, current.claude.models.deep.model);
  assert.equal(request.tier, "deep");
});

test("asks for clarification when a routing instruction cannot be resolved", () => {
  const current = config();
  assert.match(routingClarification("use the banana model for this", current) ?? "", /banana/);
  assert.match(
    routingClarification("use the banana model. Then explain the error", current) ?? "",
    /banana/,
  );
  assert.match(routingClarification("switch to Grok", current) ?? "", /Grok/i);
  assert.equal(routingClarification("switch to the main branch", current), undefined);
  assert.equal(routingClarification("use automatic routing for this review", current), undefined);
});

test("does not let a later sentence change the routing request", () => {
  const current = config();
  const request = userRoutingRequest("use Claude. Then make the implementation fast", current);

  assert.equal(request.agent, "claude");
  assert.equal(request.tier, undefined);
  assert.equal(request.model, undefined);
});

test("preserves human provider overrides through phase preferences", () => {
  const current = config();
  const base = routeTask("use Gemini to review this PR", current);
  const phaseRoute = applyPhasePreference(base, planPhases("review this PR", current)[0], current);
  assert.equal(phaseRoute.agent, "gemini");
});

test("applies explicit adaptive CLI overrides after phase preferences", () => {
  const current = config();
  const base = applyPhasePreference(
    routeTask("review this PR", current),
    planPhases("review this PR", current)[0],
    current,
  );
  const overridden = applyRouteOverrides(base, { agent: "codex", tier: "deep" }, current);
  assert.equal(overridden.agent, "codex");
  assert.equal(overridden.modelTier, "deep");
  assert.equal(overridden.model, current.codex.models.deep.model);
});

test("preserves an explicit model through adaptive phase preferences", () => {
  const current = config();
  const route = routeTask("use gpt-6-astra to review the architecture", current);
  const phaseRoute = applyPhasePreference(
    route,
    planPhases("review the architecture", current)[0],
    current,
  );

  assert.equal(phaseRoute.agent, "codex");
  assert.equal(phaseRoute.model, "gpt-6-astra");
});

test("ignores negated explicit model requests", () => {
  assert.equal(requestedModel("do not use gpt-6-astra for this", config()), undefined);
});

test("applies the first matching custom routing rule", () => {
  const custom = config({
    rules: [
      {
        name: "docs policy",
        pattern: "documentation",
        agent: "claude",
        modelTier: "balanced",
        effort: "high",
      },
    ],
  });

  const route = routeTask("Update the documentation", custom);

  assert.equal(route.matchedRule, "docs policy");
  assert.equal(route.agent, "claude");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.effort, "high");
});

test("ignores malformed custom rule expressions", () => {
  const custom = config({
    rules: [{ name: "broken", pattern: "[", agent: "claude" }],
  });

  assert.doesNotThrow(() => routeTask("Add a component", custom));
});

test("uses the configured default agent to break score ties", () => {
  const neutralTask = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
  const current = config({ defaultAgent: "claude" });
  current.history.learningEnabled = false;
  const route = routeTask(neutralTask, current);

  assert.equal(route.agent, "claude");
});

test("routes with learned feedback for Gemini and Copilot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-router-learning-"));
  try {
    for (const agent of ["gemini", "copilot"] as const) {
      const current = config();
      current.history.path = path.join(dir, `${agent}.jsonl`);
      current.history.minimumSamples = 0.9;
      appendHistory(current.history, {
        id: agent,
        timestamp: "2099-01-01T00:00:00.000Z",
        cwd: process.cwd(),
        task: `repair ${agent} parser`,
        agent,
        modelTier: "fast",
        model: current[agent].models.fast.model,
        effort: "low",
        complexity: 1,
        exitCode: 0,
        durationMs: 1,
        feedback: "good",
      });

      const route = routeTask(`repair ${agent} parser`, current);
      assert.equal(route.agent, agent);
      assert.ok(
        route.reasons.some(
          (reason) =>
            reason.agent === agent && reason.reason === "history feedback on similar tasks",
        ),
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestrates review, complex, and long requests in auto mode", () => {
  const current = config();

  assert.equal(shouldOrchestrate("Review this pull request", current), true);
  assert.equal(shouldOrchestrate("Plan a cross-module migration", current), true);
  assert.equal(shouldOrchestrate("Rename this type", current), false);
});

test("honors explicit orchestration modes", () => {
  const adaptive = config({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "adaptive" } });
  const single = config({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "single" } });

  assert.equal(shouldOrchestrate("Rename this type", adaptive), true);
  assert.equal(shouldOrchestrate("Investigate a production outage", single), false);
});

test("plans a review-only request without implementation phases", () => {
  const plans = planPhases("Review this pull request", config());

  assert.deepEqual(
    plans.map((phase) => phase.kind),
    ["review"],
  );
  assert.equal(plans[0].preferredAgent, "claude");
});

test("plans a minimal workflow for simple changes", () => {
  const plans = planPhases("Rename a type in one file", config());

  assert.deepEqual(
    plans.map((phase) => phase.kind),
    ["implement", "test"],
  );
});

test("caps planned phases at the configured maximum", () => {
  const current = config({
    orchestration: { ...DEFAULT_CONFIG.orchestration, maxPhases: 2 },
  });
  const plans = planPhases("Fix a critical production crash", current);

  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((phase) => phase.kind),
    ["analyze", "implement"],
  );
});

test("does not recover from historical failure wording in a successful result", () => {
  const route = routeTask("fix test", config());
  const execution = {
    phase: planPhases("rename a type", config())[0],
    route,
    exitCode: 0,
    durationMs: 1,
    output: "Tests failed initially, but the fix is complete and all tests now pass.",
  };

  assert.equal(needsRecovery(execution), false);
  assert.equal(
    needsRecovery({ ...execution, output: "Status: unresolved — missing credentials." }),
    true,
  );
  assert.equal(needsRecovery({ ...execution, exitCode: 1 }), true);
});
