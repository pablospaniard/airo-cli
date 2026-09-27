import { learningHints } from "./history.js";
import { AGENTS, effectiveEffort } from "./providers.js";
import type { Agent, Effort, ModelTier, RouteResult, RouterConfig, ScoreReason } from "./types.js";

const CLAUDE_SIGNALS: Array<[RegExp, number, string]> = [
  [
    /\b(root cause|investigat(e|ion)|diagnos(e|is)|why does|why is|unknown bug)\b/i,
    4,
    "investigation/root-cause task",
  ],
  [
    /\b(architecture|architectural|design|trade-?off|strategy)\b/i,
    4,
    "architecture/design reasoning",
  ],
  [
    /\b(race condition|deadlock|concurrency|intermittent|flaky|occasionally|nondeterministic)\b/i,
    5,
    "hard-to-reproduce/concurrency issue",
  ],
  [
    /\b(legacy|migration|migrate|cross[- ]module|cross[- ]cutting)\b/i,
    3,
    "migration or cross-cutting change",
  ],
  [/\b(large refactor|major refactor|re-?architect|rewrite)\b/i, 4, "large refactor"],
  [/\b(ios|android|xcode|gradle|swift|objective-c|kotlin|jni)\b/i, 2, "native/mobile context"],
  [
    /\b(performance|memory leak|profil(e|ing)|security|vulnerability)\b/i,
    3,
    "performance/security investigation",
  ],
  [
    /\b(analyze|analyse|explore|understand|audit|review architecture)\b/i,
    2,
    "repo exploration/review",
  ],
];

const CODEX_SIGNALS: Array<[RegExp, number, string]> = [
  [/\b(implement|add|create|write|build)\b/i, 2, "clear implementation request"],
  [/\b(unit test|integration test|tests|test coverage)\b/i, 3, "test implementation"],
  [
    /\b(rename|lint|format|typing|type error|typescript error|interface|types)\b/i,
    3,
    "mechanical/types task",
  ],
  [
    /\b(component|hook|endpoint|api client|schema|serializer|dto)\b/i,
    2,
    "well-scoped implementation",
  ],
  [
    /\b(boilerplate|scaffold|generate|dependency update|upgrade package)\b/i,
    3,
    "mechanical/scaffolding task",
  ],
  [/\b(fix this|change this|update this|replace this)\b/i, 2, "direct localized change"],
];

const DEEP_SIGNALS: Array<[RegExp, number, string]> = [
  [
    /\b(architecture|root cause|race condition|deadlock|security|vulnerability|large refactor|rewrite|migration)\b/i,
    2,
    "deep reasoning signal",
  ],
  [
    /\b(intermittent|flaky|occasionally|nondeterministic|unknown bug)\b/i,
    2,
    "uncertain/reproduction-heavy task",
  ],
  [
    /\b(across|cross[- ]module|without breaking|backward compatible|legacy)\b/i,
    1,
    "cross-cutting constraints",
  ],
];

const FAST_SIGNALS: Array<[RegExp, number, string]> = [
  [
    /\b(rename|lint|format|typo|types?|interface|add test|unit test|boilerplate)\b/i,
    1,
    "mechanical/low-risk task",
  ],
  [/\b(single file|one file|small change|simple|straightforward)\b/i, 1, "explicitly small scope"],
];

function add(reasons: ScoreReason[], agent: Agent, points: number, reason: string) {
  reasons.push({ agent, points, reason });
}

function clampComplexity(n: number) {
  return Math.max(1, Math.min(5, n));
}
function tierFromComplexity(c: number): ModelTier {
  if (c <= 2) return "fast";
  if (c === 3) return "balanced";
  return "deep";
}
function effortForTier(tier: ModelTier): Effort {
  return tier === "fast" ? "low" : tier === "balanced" ? "medium" : "high";
}

const MOST_POWERFUL_MODEL =
  /\b(?:use|using|choose|pick|select|with)\s+(?:the\s+)?(?:most\s+(?:powerful|powerfull|capable)|strongest)\s+(?:available\s+)?model\b/i;
const AVOID_MOST_POWERFUL_MODEL =
  /\b(?:do\s+not|don't|never|avoid)\s+use\s+(?:the\s+)?(?:most\s+(?:powerful|powerfull|capable)|strongest)\s+(?:available\s+)?model\b/i;
const EXPLICIT_MODEL =
  /\b((?:(?:gpt|codex|claude|gemini)[-._][a-z0-9][-._a-z0-9]*|o[1-9](?:[-._][a-z0-9][-._a-z0-9]*)?|haiku|sonnet|opus))\b/gi;

export interface UserRoutingRequest {
  intent: boolean;
  automatic?: boolean;
  agent?: Agent;
  model?: string;
  tier?: ModelTier;
  unresolved?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configuredModelIn(
  text: string,
  config: RouterConfig,
): { agent: Agent; model: string; tier: ModelTier } | undefined {
  const matches: Array<{ index: number; agent: Agent; model: string; tier: ModelTier }> = [];
  for (const agent of AGENTS) {
    for (const tier of ["fast", "balanced", "deep"] as const) {
      const model = config[agent].models[tier].model;
      const flexible = escapeRegex(model).replace(/[-._]+/g, "[-._\\s]+");
      const match = new RegExp(`\\b${flexible}\\b`, "i").exec(text);
      if (match) matches.push({ index: match.index, agent, model, tier });
    }
  }
  return matches.sort((a, b) => b.index - a.index)[0];
}

function routingClauses(task: string): Array<{ index: number; text: string; switchLike: boolean }> {
  const clauses: Array<{ index: number; text: string; switchLike: boolean }> = [];
  const patterns: Array<[RegExp, boolean]> = [
    [
      /\b(?:switch|change|move|route)(?:\s+(?:it|this|the\s+task))?\s+(?:over\s+)?to\s+((?:(?![,;!?\n]|\.(?=\s+[A-Z]|\s*$)).)+)/gi,
      true,
    ],
    [
      /\b(?:use|using|choose|pick|select|run(?:\s+it)?\s+with|go\s+with|with)\s+((?:(?![,;!?\n]|\.(?=\s+[A-Z]|\s*$)).)+)/gi,
      false,
    ],
    [/\bmodel\s+([a-z0-9][a-z0-9._-]*)\b/gi, false],
  ];
  for (const [pattern, switchLike] of patterns) {
    for (const match of task.matchAll(pattern)) {
      const prefix = task.slice(Math.max(0, (match.index ?? 0) - 20), match.index ?? 0);
      if (/(?:do\s+not|don't|never|avoid)\s*$/i.test(prefix)) continue;
      clauses.push({ index: match.index ?? 0, text: match[1].trim(), switchLike });
    }
  }
  return clauses.sort((a, b) => a.index - b.index);
}

export function userRoutingRequest(task: string, config: RouterConfig): UserRoutingRequest {
  let latest: UserRoutingRequest = { intent: false };
  for (const clause of routingClauses(task)) {
    const text = clause.text.replace(/^(?:use|using)\s+/i, "").trim();
    const lower = text.toLowerCase();
    const knownAgent = AGENTS.find((agent) => new RegExp(`\\b${agent}\\b`, "i").test(text));
    const configured = configuredModelIn(text, config);
    const namedModelMatches = [...text.matchAll(EXPLICIT_MODEL)];
    const namedModel = namedModelMatches.at(-1)?.[1];
    const automatic = /\b(?:auto|automatic|automatically)\b/i.test(text);
    let tier: ModelTier | undefined;
    if (/\b(?:deep|most\s+(?:powerful|capable)|strongest)\b/i.test(text)) tier = "deep";
    else if (/\bbalanced\b/i.test(text)) tier = "balanced";
    else if (/\b(?:fast|fastest|quick|quickest|cheapest)\b/i.test(text)) tier = "fast";

    const alias = /\b(haiku|sonnet|opus|flash|pro|luna|terra|sol)\b/i.exec(text)?.[1].toLowerCase();
    const aliasTier: ModelTier | undefined =
      alias && ["haiku", "flash", "luna"].includes(alias)
        ? "fast"
        : alias && ["sonnet", "pro", "terra"].includes(alias)
          ? "balanced"
          : alias && ["opus", "sol"].includes(alias)
            ? "deep"
            : undefined;
    tier ??= configured?.tier ?? aliasTier;

    let agent = knownAgent ?? configured?.agent;
    let model = namedModel ?? configured?.model;
    if (!agent && model) agent = agentForModel(model, config);
    if (knownAgent && aliasTier && (!namedModel || namedModel.toLowerCase() === alias))
      model = config[knownAgent].models[aliasTier].model;
    if (knownAgent && configured && configured.agent !== knownAgent) {
      model = config[knownAgent].models[configured.tier].model;
      tier = configured.tier;
    }

    const recognized = Boolean(automatic || agent || model || tier);
    const excludedSwitchTarget =
      /\b(?:branch|file|folder|directory|tab|theme|language|mode)\b/i.test(text);
    const explicitRoutingNoun =
      /\b(?:model|provider|agent|tier)\b/i.test(text) && !/\bprovider['’]s\b/i.test(text);
    const intent =
      recognized || (clause.switchLike && !excludedSwitchTarget) || explicitRoutingNoun;
    if (!intent) continue;

    let unresolved: string | undefined;
    if (!recognized) unresolved = text;
    else if (/\bmodel\b/i.test(text) && agent && !model && !tier) {
      const remainder = lower
        .replace(/\b(?:the|a|an|model|provider|agent|tier|claude|codex|gemini|copilot)\b/g, "")
        .trim();
      if (remainder) unresolved = text;
    }
    latest = { intent: true, automatic, agent, model, tier, unresolved };
  }
  return latest;
}

export function routingClarification(task: string, config: RouterConfig): string | undefined {
  const request = userRoutingRequest(task, config);
  if (!request.unresolved) return undefined;
  return `I couldn't identify the requested provider, model, or tier from "${request.unresolved}". Which should I use? For example: "Claude with Opus", "Codex deep", "Gemini fast", or "automatic routing".`;
}

export function requestedModelTier(task: string): ModelTier | undefined {
  if (AVOID_MOST_POWERFUL_MODEL.test(task)) return undefined;
  if (MOST_POWERFUL_MODEL.test(task)) return "deep";
  return undefined;
}

export function agentForModel(model: string, config: RouterConfig): Agent | undefined {
  for (const agent of AGENTS) {
    if (
      Object.values(config[agent].models).some(
        (profile) => profile.model.toLowerCase() === model.toLowerCase(),
      )
    )
      return agent;
  }
  if (/^(?:claude(?:-|$)|haiku$|sonnet$|opus$)/i.test(model)) return "claude";
  if (/^(?:gpt(?:-|$)|codex(?:-|$)|o[1-9](?:-|$))/i.test(model)) return "codex";
  if (/^gemini(?:-|$)/i.test(model)) return "gemini";
  return undefined;
}

export function requestedModel(
  task: string,
  config: RouterConfig,
): { agent: Agent; model: string } | undefined {
  const request = userRoutingRequest(task, config);
  return request.model && request.agent
    ? { agent: request.agent, model: request.model }
    : undefined;
}

export function routeTask(task: string, config: RouterConfig): RouteResult {
  const reasons: ScoreReason[] = [];
  const modelReasons: string[] = [];
  let forcedAgent: Agent | undefined;
  let forcedTier: ModelTier | undefined;
  let forcedEffort: Effort | undefined;
  let matchedRule: string | undefined;
  const naturalRequest = userRoutingRequest(task, config);
  const userRequestedTier = naturalRequest.tier ?? requestedModelTier(task);
  const explicitModel = requestedModel(task, config);

  for (const rule of config.rules) {
    try {
      if (new RegExp(rule.pattern, "i").test(task)) {
        forcedAgent = rule.agent;
        forcedTier = rule.modelTier;
        forcedEffort = rule.effort;
        matchedRule = rule.name;
        if (rule.agent) add(reasons, rule.agent, 100, `matched rule: ${rule.name}`);
        if (rule.modelTier) modelReasons.push(`rule ${rule.name} forced ${rule.modelTier} tier`);
        break;
      }
    } catch {
      /* ignore malformed regex */
    }
  }

  for (const [pattern, points, reason] of CLAUDE_SIGNALS)
    if (pattern.test(task)) add(reasons, "claude", points, reason);
  for (const [pattern, points, reason] of CODEX_SIGNALS)
    if (pattern.test(task)) add(reasons, "codex", points, reason);

  const words = task.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 45) add(reasons, "claude", 2, "long/compound request");
  if (words <= 12) add(reasons, "codex", 1, "short/well-scoped request");
  const compounds = (task.match(/\b(and|also|while|without|across|then|after|before)\b/gi) ?? [])
    .length;
  if (compounds >= 3) add(reasons, "claude", 2, "multiple constraints/subtasks");
  if (config.policy === "claude-heavy") add(reasons, "claude", 2, "claude-heavy policy");
  if (config.policy === "codex-heavy") add(reasons, "codex", 2, "codex-heavy policy");

  const learned = learningHints(task, config.history);
  const agents = [...AGENTS];
  for (const candidate of agents) {
    const boost = learned.agentBoosts[candidate];
    if (boost !== 0) add(reasons, candidate, boost, "history feedback on similar tasks");
  }
  modelReasons.push(...learned.notes);

  const scores = Object.fromEntries(
    agents.map((candidate) => [
      candidate,
      reasons
        .filter((reason) => reason.agent === candidate)
        .reduce((sum, reason) => sum + reason.points, 0),
    ]),
  ) as Record<Agent, number>;
  const claudeScore = scores.claude;
  const codexScore = scores.codex;
  const bestScore = Math.max(...Object.values(scores));
  const highestScoringAgents = agents.filter((candidate) => scores[candidate] === bestScore);
  const learnedAgent = highestScoringAgents.includes(config.defaultAgent)
    ? config.defaultAgent
    : highestScoringAgents[0];
  const agent = explicitModel?.agent ?? naturalRequest.agent ?? forcedAgent ?? learnedAgent;

  let complexity = 2;
  if (words >= 20) complexity += 1;
  if (words >= 55) complexity += 1;
  for (const [pattern, points, reason] of DEEP_SIGNALS)
    if (pattern.test(task)) {
      complexity += points;
      modelReasons.push(reason);
    }
  for (const [pattern, points, reason] of FAST_SIGNALS)
    if (pattern.test(task)) {
      complexity -= points;
      modelReasons.push(reason);
    }
  if (compounds >= 3) complexity += 1;
  complexity = clampComplexity(complexity);

  let modelTier = userRequestedTier ?? forcedTier ?? tierFromComplexity(complexity);
  if (!userRequestedTier && !forcedTier && config.history.learningEnabled) {
    const scores = learned.tierBoosts;
    const best = (Object.keys(scores) as ModelTier[]).sort((a, b) => scores[b] - scores[a])[0];
    if (scores[best] >= 1.25 && scores[best] > scores[modelTier] + 0.5) {
      modelReasons.push(`history favored ${best} tier for similar tasks`);
      modelTier = best;
    }
  }

  if (!userRequestedTier && !forcedTier && !explicitModel && config.history.learningEnabled) {
    const candidates = (["fast", "balanced", "deep"] as ModelTier[]).map((tier) => {
      const candidate = config[agent].models[tier];
      const effort = effectiveEffort(agent, candidate.effort ?? effortForTier(tier));
      const key = `${agent}/${candidate.model}/${effort}`;
      return {
        tier,
        utility: learned.routeUtilities[key] ?? 0,
        samples: learned.routeSamples[key] ?? 0,
      };
    });
    const minimumSamples = config.history.minimumSamples ?? 2;
    const qualified = candidates.filter((candidate) => candidate.samples >= minimumSamples);
    const bestLearned = qualified.sort((a, b) => b.utility - a.utility)[0];
    const current = candidates.find((candidate) => candidate.tier === modelTier)!;
    if (bestLearned && bestLearned.utility > current.utility + 0.2) {
      modelTier = bestLearned.tier;
      modelReasons.push(
        `route outcomes favored ${bestLearned.tier} tier (utility ${bestLearned.utility.toFixed(2)}, effective samples ${bestLearned.samples.toFixed(1)})`,
      );
    } else if (
      (config.history.explorationRate ?? 0) > 0 &&
      Math.random() < (config.history.explorationRate ?? 0)
    ) {
      const exploratory = [...candidates].sort((a, b) => a.samples - b.samples)[0];
      modelTier = exploratory.tier;
      modelReasons.push(`controlled exploration selected under-observed ${exploratory.tier} tier`);
    }
  }

  const profile = config[agent].models[modelTier];
  const requestedEffort = forcedEffort ?? profile.effort ?? effortForTier(modelTier);
  const effort = effectiveEffort(agent, requestedEffort);
  if (effort !== requestedEffort)
    modelReasons.push(`${agent} does not expose an AIRO effort control → using auto`);
  const routeKey = `${agent}/${explicitModel?.model ?? profile.model}/${effort}`;
  modelReasons.unshift(`complexity ${complexity}/5 → ${modelTier} tier`);
  if (userRequestedTier)
    modelReasons.unshift(`user explicitly requested the ${userRequestedTier} tier`);
  if (explicitModel) modelReasons.unshift(`user explicitly requested ${explicitModel.model}`);

  return {
    agent,
    modelTier,
    userRequestedAgent: naturalRequest.agent,
    userRequestedTier,
    userRequestedModel: explicitModel?.model,
    agentPinned: Boolean(explicitModel ?? naturalRequest.agent),
    model: explicitModel?.model ?? profile.model,
    effort,
    complexity,
    claudeScore,
    codexScore,
    agentScores: scores,
    reasons,
    modelReasons,
    matchedRule,
    learningConfidence: learned.confidence,
    expectedUtility: learned.routeUtilities[routeKey],
  };
}
