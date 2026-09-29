#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DEFAULT_CONFIG } from "../dist/config.js";
import { routeTask } from "../dist/router.js";
import {
  ROUTING_POLICY_CASES,
  ROUTING_POLICY_DATASET,
} from "../dist/test/fixtures/routing-policy-cases.js";

const QUESTION_SET_VERSION = "1.0.0";
const PROVIDERS = ["claude", "codex", "gemini", "copilot"];
const TIERS = ["fast", "balanced", "deep"];
const CATEGORIES = ["debug", "implement", "review", "research", "test", "general"];
const RISKS = ["low", "medium", "high"];

const QUESTIONS = [
  {
    id: "task_category",
    type: "choice",
    instructions: "Which category best describes the primary work requested in `task`?",
    options: CATEGORIES,
  },
  {
    id: "risk",
    type: "choice",
    instructions: "What is the consequence and operational risk of the work requested in `task`?",
    options: [
      { name: "low", description: "Localized, mechanical, and readily reversible" },
      { name: "medium", description: "Cross-file, API, migration, or compatibility-sensitive" },
      {
        name: "high",
        description: "Production, security, outage, payment, auth, or data-loss risk",
      },
    ],
  },
  {
    id: "tier",
    type: "choice",
    instructions: "Which reasoning tier is proportionate for completing `task` safely?",
    options: [
      { name: "fast", description: "Routine, localized, and low uncertainty" },
      { name: "balanced", description: "Moderate scope or uncertainty" },
      { name: "deep", description: "Complex, risky, cross-cutting, or investigation-heavy" },
    ],
  },
  {
    id: "provider",
    type: "choice",
    instructions: "Which registered capability profile best fits `task`?",
    options: [
      {
        name: "claude",
        description: "Investigation, research, review, architecture, and high-risk work",
      },
      {
        name: "codex",
        description: "Implementation, tests, debugging, and scoped engineering work",
      },
      { name: "gemini", description: "Research, review, and complex information synthesis" },
      { name: "copilot", description: "Scoped implementation, tests, and review assistance" },
    ],
  },
  {
    id: "decision_appropriate",
    type: "noul",
    instructions:
      "Is `airo_decision` a proportionate and semantically appropriate provider and tier for `task`?",
    criteria: {
      true: "The provider profile fits the work and the tier is neither insufficient nor excessive",
      false:
        "The provider profile is a poor fit or the tier is materially insufficient or excessive",
    },
  },
];

function usage() {
  return `Usage: pnpm evaluate:jev -- --model MODEL [--dataset all|calibration|held-out] [--output FILE] [--jev-command PATH] [--limit N]

Runs the development-only Jev evaluator over reviewed routing fixtures.
MODEL is required and must be an explicitly pinned Jev model identifier.
The Jev CLI resolves TYPESAFE_API_KEY; this script never accepts or stores the key.`;
}

function parseArgs(argv) {
  const options = { jevCommand: process.env.AIRO_JEV_COMMAND || "jev", dataset: "all" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (!["--model", "--dataset", "--output", "--jev-command", "--limit"].includes(value))
      throw new Error(`Unknown argument: ${value}`);
    const next = argv[++index];
    if (!next) throw new Error(`${value} requires a value`);
    if (value === "--model") options.model = next;
    if (value === "--dataset") options.dataset = next;
    if (value === "--output") options.output = next;
    if (value === "--jev-command") options.jevCommand = next;
    if (value === "--limit") options.limit = Number(next);
  }
  if (!options.model)
    throw new Error("--model is required; development evaluations must be pinned");
  if (!/\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?$/i.test(options.model))
    throw new Error(`${options.model} is not pinned; provide an exact versioned model`);
  if (!["all", "calibration", "held-out"].includes(options.dataset))
    throw new Error("--dataset must be all, calibration, or held-out");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
    throw new Error("--limit must be a positive integer");
  return options;
}

function choice(answer, allowed, id) {
  if (!answer || answer.type !== "choice" || !allowed.includes(answer.choice))
    throw new Error(`Malformed Jev choice answer: ${id}`);
  if (
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  )
    throw new Error(`Malformed Jev confidence: ${id}`);
  if (!answer.probabilities || typeof answer.probabilities !== "object")
    throw new Error(`Missing Jev probabilities: ${id}`);
  for (const option of allowed) {
    const probability = answer.probabilities[option];
    if (typeof probability !== "number" || probability < 0 || probability > 1)
      throw new Error(`Malformed Jev probability: ${id}.${option}`);
  }
  const probabilitySum = allowed.reduce((sum, option) => sum + answer.probabilities[option], 0);
  if (Math.abs(probabilitySum - 1) > 0.02)
    throw new Error(`Jev probabilities are not normalized: ${id}`);
  return answer.choice;
}

function validateResponse(response) {
  if (!response || typeof response !== "object" || typeof response.model !== "string")
    throw new Error("Malformed Jev response metadata");
  const answers = response.answers;
  if (!answers || typeof answers !== "object") throw new Error("Missing Jev answers");
  choice(answers.task_category, CATEGORIES, "task_category");
  choice(answers.risk, RISKS, "risk");
  choice(answers.tier, TIERS, "tier");
  choice(answers.provider, PROVIDERS, "provider");
  const appropriate = answers.decision_appropriate;
  if (
    !appropriate ||
    appropriate.type !== "noul" ||
    typeof appropriate.noul !== "number" ||
    appropriate.noul < 0 ||
    appropriate.noul > 1
  )
    throw new Error("Malformed Jev noul answer: decision_appropriate");
  return response;
}

function jevCliVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Unable to run Jev CLI: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`Jev CLI version check failed with exit ${result.status}`);
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
  if (!version) throw new Error("Jev CLI returned no version");
  return version;
}

function evaluateFixture(fixture, options, temporaryFile) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.history.enabled = false;
  config.history.learningEnabled = false;
  const route = routeTask(fixture.task, config);
  const document = {
    state: {
      task: fixture.task,
      airo_decision: {
        provider: route.agent,
        tier: route.modelTier,
        complexity: route.complexity,
        policy_version: route.routingPolicyVersion,
      },
    },
    questions: QUESTIONS,
  };
  fs.writeFileSync(temporaryFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  const result = spawnSync(
    options.jevCommand,
    ["ask", temporaryFile, "--json", "--model", options.model],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw new Error(`Unable to run Jev CLI: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `Jev CLI failed with exit ${result.status}: ${result.stderr.trim().slice(0, 500)}`,
    );
  let response;
  try {
    response = validateResponse(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Jev CLI returned invalid JSON");
    throw error;
  }
  if (response.model !== options.model)
    throw new Error(`Jev returned model ${response.model}; expected pinned model ${options.model}`);
  return {
    fixtureId: fixture.id,
    split: fixture.split,
    expected: { provider: fixture.expectedAgent, tier: fixture.expectedTier },
    airo: {
      provider: route.agent,
      tier: route.modelTier,
      complexity: route.complexity,
      policyVersion: route.routingPolicyVersion,
    },
    jev: {
      model: response.model,
      answers: response.answers,
      usage: response.usage,
      requestId: response.request_id ?? response.requestId,
    },
    agreement: {
      provider: response.answers.provider.choice === route.agent,
      tier: response.answers.tier.choice === route.modelTier,
      appropriateProbability: response.answers.decision_appropriate.noul,
    },
  };
}

function proportion(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function mean(values) {
  return values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
    : null;
}

function accuracy(records, source) {
  const provider = records.filter((record) => {
    const selected = source === "airo" ? record.airo.provider : record.jev.answers.provider.choice;
    return selected === record.expected.provider;
  }).length;
  const tier = records.filter((record) => {
    const selected = source === "airo" ? record.airo.tier : record.jev.answers.tier.choice;
    return selected === record.expected.tier;
  }).length;
  const joint = records.filter((record) => {
    const selectedProvider =
      source === "airo" ? record.airo.provider : record.jev.answers.provider.choice;
    const selectedTier = source === "airo" ? record.airo.tier : record.jev.answers.tier.choice;
    return selectedProvider === record.expected.provider && selectedTier === record.expected.tier;
  }).length;
  return {
    provider: proportion(provider, records.length),
    tier: proportion(tier, records.length),
    joint: proportion(joint, records.length),
  };
}

function jointCorrect(record, source) {
  const provider = source === "airo" ? record.airo.provider : record.jev.answers.provider.choice;
  const tier = source === "airo" ? record.airo.tier : record.jev.answers.tier.choice;
  return provider === record.expected.provider && tier === record.expected.tier;
}

function comparison(records) {
  const airo = accuracy(records, "airo");
  const jev = accuracy(records, "jev");
  return {
    records: records.length,
    airo,
    jev,
    delta: {
      provider: airo.provider === null ? null : Number((jev.provider - airo.provider).toFixed(4)),
      tier: airo.tier === null ? null : Number((jev.tier - airo.tier).toFixed(4)),
      joint: airo.joint === null ? null : Number((jev.joint - airo.joint).toFixed(4)),
    },
    agreement: {
      provider: proportion(
        records.filter((record) => record.airo.provider === record.jev.answers.provider.choice)
          .length,
        records.length,
      ),
      tier: proportion(
        records.filter((record) => record.airo.tier === record.jev.answers.tier.choice).length,
        records.length,
      ),
    },
    confidence: {
      provider: mean(records.map((record) => record.jev.answers.provider.confidence)),
      tier: mean(records.map((record) => record.jev.answers.tier.confidence)),
      appropriateProbability: mean(
        records.map((record) => record.jev.answers.decision_appropriate.noul),
      ),
    },
  };
}

function calibrationReview(records) {
  const calibration = records.filter((record) => record.split === "calibration");
  const candidates = calibration
    .filter(
      (record) =>
        !jointCorrect(record, "airo") &&
        jointCorrect(record, "jev") &&
        record.jev.answers.provider.confidence >= 0.7 &&
        record.jev.answers.tier.confidence >= 0.7,
    )
    .map((record) => ({
      fixtureId: record.fixtureId,
      current: { provider: record.airo.provider, tier: record.airo.tier },
      suggested: {
        provider: record.jev.answers.provider.choice,
        tier: record.jev.answers.tier.choice,
      },
      confidence: {
        provider: record.jev.answers.provider.confidence,
        tier: record.jev.answers.tier.confidence,
      },
    }));
  return {
    policyModified: false,
    action: candidates.length ? "human-review-required" : "no-policy-change-suggested",
    candidateThreshold: 0.7,
    candidates,
  };
}

function heldOutReview(records) {
  const heldOut = records.filter((record) => record.split === "held-out");
  const improvements = heldOut
    .filter((record) => !jointCorrect(record, "airo") && jointCorrect(record, "jev"))
    .map((record) => record.fixtureId);
  const regressions = heldOut
    .filter((record) => jointCorrect(record, "airo") && !jointCorrect(record, "jev"))
    .map((record) => record.fixtureId);
  const metrics = comparison(heldOut);
  return {
    status: !heldOut.length
      ? "not-evaluated"
      : regressions.length
        ? "regression-risk"
        : (metrics.delta.joint ?? 0) > 0
          ? "supporting-evidence"
          : "no-measured-improvement",
    ...metrics,
    improvements,
    regressions,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "airo-jev-evaluation-"));
  try {
    const cliVersion = jevCliVersion(options.jevCommand);
    const selected =
      options.dataset === "all"
        ? ROUTING_POLICY_CASES
        : ROUTING_POLICY_CASES.filter((fixture) => fixture.split === options.dataset);
    const fixtures = selected.slice(0, options.limit);
    const records = fixtures.map((fixture) =>
      evaluateFixture(fixture, options, path.join(temporaryDirectory, "request.json")),
    );
    const report = {
      schemaVersion: 2,
      questionSetVersion: QUESTION_SET_VERSION,
      requestedModel: options.model,
      jevCliVersion: cliVersion,
      evaluatedAt: new Date().toISOString(),
      dataset: {
        name: "routing-policy-cases",
        version: ROUTING_POLICY_DATASET.version,
        selectedSplit: options.dataset,
        provenance: ROUTING_POLICY_DATASET.provenance,
        privacyReview: ROUTING_POLICY_DATASET.privacyReview,
      },
      disclosure: [
        "reviewed fixture task",
        "AIRO provider",
        "AIRO tier",
        "complexity",
        "policy version",
      ],
      records,
      comparison: {
        overall: comparison(records),
        calibration: comparison(records.filter((record) => record.split === "calibration")),
        heldOut: comparison(records.filter((record) => record.split === "held-out")),
      },
      calibration: calibrationReview(records),
      heldOut: heldOutReview(records),
      policyModified: false,
      reviewRequiredBeforePolicyChange: true,
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const output = path.resolve(options.output);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, serialized, { mode: 0o600 });
      fs.chmodSync(output, 0o600);
      process.stdout.write(
        `Wrote ${records.length} Jev evaluation record(s) to ${options.output}\n`,
      );
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main();
