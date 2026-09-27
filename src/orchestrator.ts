import { inspectAccount } from "./account.js";
import { AGENTS, effectiveEffort, providerDefinition } from "./providers.js";
import { appendHistory, newHistoryId, newRunId, updateHistoryRecord } from "./history.js";
import { routeTask } from "./router.js";
import {
  addTokenUsage,
  commandExists,
  isPermissionApproval,
  isProviderAuthError,
  isProviderUnavailableError,
  runAgent,
} from "./runner.js";
import type {
  Agent,
  Effort,
  ModelTier,
  PhaseExecution,
  PhaseKind,
  PhasePlan,
  RouteResult,
  RouterConfig,
  SessionState,
} from "./types.js";
import { compactSessionContext } from "./session.js";
import { RunLogger } from "./logging.js";
import { agentColor, brand, statusIcon, tierColor, ui } from "./ui.js";
import type { LogLevel } from "./types.js";
import { evaluateRoute, extractTaskFeatures } from "./evaluation.js";
import { LONG_RUNNING_PROCESS_PROTOCOL } from "./prompts.js";

const CRITICAL =
  /\b(critical|production|prod|sev[ -]?[01]|p[ -]?0|outage|crash|data loss|security|vulnerability|deadlock|race condition)\b/i;
const REVIEW = /\b(review|audit|inspect|code review|pr review|pull request)\b/i;
const BUG = /\b(bug|fix|broken|failure|failing|error|crash|issue|regression|wrong|incorrect)\b/i;
const COMPLEX =
  /\b(architecture|migration|migrate|refactor|legacy|cross[- ]module|root cause|intermittent|flaky|concurrency|performance)\b/i;
const SIMPLE =
  /\b(typo|rename|lint|format|type error|typescript error|small|simple|one file|single file)\b/i;

function phase(
  id: string,
  kind: PhaseKind,
  title: string,
  instruction: string,
  preferredAgent?: Agent,
  preferredTier?: ModelTier,
  preferredEffort?: Effort,
): PhasePlan {
  return { id, kind, title, instruction, preferredAgent, preferredTier, preferredEffort };
}

export function shouldOrchestrate(task: string, config: RouterConfig): boolean {
  if (config.orchestration.mode === "adaptive") return true;
  if (config.orchestration.mode === "single") return false;
  const words = task.trim().split(/\s+/).filter(Boolean).length;
  return (
    CRITICAL.test(task) ||
    REVIEW.test(task) ||
    COMPLEX.test(task) ||
    (BUG.test(task) && words >= 12) ||
    words >= 35
  );
}

export function planPhases(task: string, config: RouterConfig): PhasePlan[] {
  const critical = CRITICAL.test(task);
  const reviewOnly =
    REVIEW.test(task) && !BUG.test(task) && !/\b(implement|change|modify|fix)\b/i.test(task);
  const simple = SIMPLE.test(task) && !critical && !COMPLEX.test(task);
  const plans: PhasePlan[] = [];

  if (reviewOnly) {
    plans.push(
      phase(
        "review",
        "review",
        "Deep review",
        "Review the current repository changes or relevant code against the user's request. Identify concrete defects, regressions, missing tests, risky assumptions, and actionable improvements. Do not make code changes unless the user explicitly asked for them.",
        "claude",
        critical ? "deep" : "balanced",
        critical ? "high" : "medium",
      ),
    );
    return plans;
  }

  if (!simple) {
    plans.push(
      phase(
        "analyze",
        "analyze",
        critical ? "Critical root-cause analysis" : "Analyze",
        "Investigate the request before editing. Inspect the relevant code paths, determine the root cause or implementation approach, identify risks and affected areas, and leave the repository ready for implementation. Avoid speculative broad rewrites.",
        "claude",
        critical ? "deep" : "balanced",
        critical ? "high" : "medium",
      ),
    );
  }

  plans.push(
    phase(
      "implement",
      "implement",
      critical ? "Minimal safe fix" : "Implement",
      "Implement the requested change using the repository's existing conventions. Keep the change scoped, preserve compatibility unless the task says otherwise, and incorporate findings left by prior phases in the working tree.",
      "codex",
      critical || COMPLEX.test(task) ? "deep" : simple ? "fast" : "balanced",
      critical ? "xhigh" : simple ? "low" : "medium",
    ),
  );

  plans.push(
    phase(
      "test",
      "test",
      "Validate",
      "Validate the implementation. Run the most relevant existing tests, type checks, linters, or build checks available for the changed area. Fix straightforward failures caused by the change. Do not hide unrelated failures.",
      "codex",
      critical ? "balanced" : "fast",
      critical ? "high" : "low",
    ),
  );

  if (config.orchestration.autoReview && (!simple || critical)) {
    plans.push(
      phase(
        "review",
        "review",
        "Regression review",
        "Review the final diff and relevant surrounding code for correctness, regressions, edge cases, missing tests, and unnecessary complexity. If you find a concrete issue introduced by this task, fix it and re-run the smallest relevant validation.",
        "claude",
        critical ? "deep" : "balanced",
        critical ? "high" : "medium",
      ),
    );
  }

  return plans.slice(0, config.orchestration.maxPhases);
}

function phaseTask(originalTask: string, phasePlan: PhasePlan, prior: PhaseExecution[]): string {
  const priorSummary = prior.length
    ? `\n\nPrior phase outcomes:\n${prior.map((p) => `- ${p.phase.kind}: exit=${p.exitCode}; ${tail(p.output, 1200)}`).join("\n")}`
    : "";
  return `[adaptive phase: ${phasePlan.kind}]\nOriginal request: ${originalTask}\n\nPhase objective: ${phasePlan.instruction}${priorSummary}\n\nExecution contract: Work from the current shared working tree and verify important results before claiming success. Only share URLs that you actually verified; clearly label localhost URLs as local-only. If you create or generate a user-visible file, persist it in the project (unless the user chose another location), verify that it exists, and link its absolute path. Render generated images with Markdown image syntax so compatible clients can preview them. In the final phase, give a self-contained user-facing handoff covering the completed work, validation, artifact paths, and any unresolved issue—not merely a phase-status report.\n\n${LONG_RUNNING_PROCESS_PROTOCOL}\n\nClarification protocol: If you cannot safely continue without a user decision, do not guess. If a required command is blocked by the sandbox or permissions, output exactly AIROUTE_QUESTION: Permission required to <describe the blocked action>. Approve? and stop; do not claim the phase is complete. For any other blocking decision, output exactly one line in the form AIROUTE_QUESTION: <your concise question> and stop. Otherwise continue normally.`;
}

function tail(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : clean.slice(-n);
}

export function applyPhasePreference(
  base: RouteResult,
  p: PhasePlan,
  config: RouterConfig,
): RouteResult {
  const route = { ...base, reasons: [...base.reasons], modelReasons: [...base.modelReasons] };
  if (p.preferredAgent && !route.userRequestedAgent && !route.userRequestedModel) {
    route.agent = p.preferredAgent;
    route.reasons.push({
      agent: p.preferredAgent,
      points: 20,
      reason: `phase ${p.kind} preference`,
    });
  }
  if (p.preferredTier && !route.userRequestedTier && !route.userRequestedModel)
    route.modelTier = p.preferredTier;
  const profile = config[route.agent].models[route.modelTier];
  if (!route.userRequestedModel) route.model = profile.model;
  route.effort = effectiveEffort(
    route.agent,
    route.userRequestedTier || route.userRequestedModel
      ? (profile.effort ?? route.effort)
      : (p.preferredEffort ?? profile.effort ?? route.effort),
  );
  route.modelReasons.push(`phase ${p.kind} → ${route.agent}/${route.modelTier}`);
  return route;
}

export interface RouteOverrides {
  agent?: Agent;
  tier?: ModelTier;
  model?: string;
  effort?: Effort;
}

/** Apply persistent UI preferences as defaults while preserving choices in the current prompt. */
export function applyRoutePreferences(
  base: RouteResult,
  preferences: Pick<RouteOverrides, "agent" | "tier">,
  config: RouterConfig,
): RouteResult {
  const agent = base.userRequestedAgent || base.userRequestedModel ? undefined : preferences.agent;
  const tier = base.userRequestedTier || base.userRequestedModel ? undefined : preferences.tier;
  return applyRouteOverrides(base, { agent, tier }, config);
}

export function applyRouteOverrides(
  base: RouteResult,
  overrides: RouteOverrides,
  config: RouterConfig,
): RouteResult {
  const route = { ...base, reasons: [...base.reasons], modelReasons: [...base.modelReasons] };
  if (!overrides.agent && !overrides.tier && !overrides.model && !overrides.effort) return route;
  if (overrides.agent) {
    route.agent = overrides.agent;
    route.agentPinned = true;
  }
  if (overrides.tier) route.modelTier = overrides.tier;
  const profile = config[route.agent].models[route.modelTier];
  if (overrides.agent || overrides.tier) route.model = profile.model;
  if (overrides.model) route.model = overrides.model;
  if (overrides.agent || overrides.tier)
    route.effort = effectiveEffort(route.agent, profile.effort ?? route.effort);
  if (overrides.effort) route.effort = effectiveEffort(route.agent, overrides.effort);
  if (overrides.agent || overrides.tier || overrides.model)
    route.modelReasons.push(`explicit flags → ${route.agent}/${route.model} (${route.modelTier})`);
  return route;
}

export function unavailableProviderError(route: RouteResult, config: RouterConfig): Error {
  return new Error(
    `${route.agent} was explicitly selected but ${config[route.agent].command} is not available in PATH. Install it or pick another provider; AIRO will not substitute a different provider for an explicit choice.`,
  );
}

/** Reason a provider dropped out of a run, used for logs and route explanations. */
export type ProviderFailure = "usage limit" | "authentication";

export function providerFailureReason(text: string, exitCode?: number): ProviderFailure {
  return isProviderAuthError(text, exitCode) ? "authentication" : "usage limit";
}

/** Cheap per-phase check: installed, and not already ruled out earlier in this run. */
function providerAvailable(agent: Agent, config: RouterConfig, ruledOut: Set<Agent>): boolean {
  return !ruledOut.has(agent) && commandExists(config[agent].command);
}

/** Rank alternatives by evidence for this task, then by the registry's stable preference. */
function fallbackCandidates(route: RouteResult): Agent[] {
  return AGENTS.filter((agent) => agent !== route.agent).sort((a, b) => {
    const scoreDifference = (route.agentScores?.[b] ?? 0) - (route.agentScores?.[a] ?? 0);
    if (scoreDifference !== 0) return scoreDifference;
    return providerDefinition(a).fallbackPriority - providerDefinition(b).fallbackPriority;
  });
}

function availableFallback(
  route: RouteResult,
  config: RouterConfig,
  ruledOut: Set<Agent>,
  verifyAccount: boolean,
): Agent | undefined {
  for (const candidate of fallbackCandidates(route)) {
    if (!providerAvailable(candidate, config, ruledOut)) continue;
    if (verifyAccount && inspectAccount(candidate, config)?.authenticated === false) {
      ruledOut.add(candidate);
      continue;
    }
    return candidate;
  }
  return undefined;
}

export function fallbackIfMissing(
  route: RouteResult,
  config: RouterConfig,
  ruledOut: Set<Agent> = new Set(),
): RouteResult {
  if (providerAvailable(route.agent, config, ruledOut)) return route;
  if (route.agentPinned) throw unavailableProviderError(route, config);
  const fallback = availableFallback(route, config, ruledOut, false);
  if (!fallback) throw new Error("No registered provider CLI is available in PATH");
  const p = config[fallback].models[route.modelTier];
  return {
    ...route,
    agent: fallback,
    model: p.model,
    effort: effectiveEffort(fallback, p.effort ?? route.effort),
    modelReasons: [...route.modelReasons, `provider missing → fallback ${fallback}`],
  };
}

/**
 * Pick a provider to take over after the current one failed for reasons that
 * are about the provider rather than the task. Runs on the failure path only,
 * so it can afford a sign-in probe: falling back to a second provider that is
 * installed but not signed in would only repeat the same failure.
 */
export function fallbackProvider(
  route: RouteResult,
  config: RouterConfig,
  failure: ProviderFailure,
  ruledOut: Set<Agent> = new Set(),
): RouteResult | undefined {
  if (route.agentPinned) return undefined;
  const fallback = availableFallback(route, config, ruledOut, true);
  if (!fallback) return undefined;
  const profile = config[fallback].models[route.modelTier];
  return {
    ...route,
    agent: fallback,
    model: profile.model,
    effort: effectiveEffort(fallback, profile.effort ?? route.effort),
    modelReasons: [...route.modelReasons, `provider ${failure} → fallback ${fallback}`],
  };
}

export function needsRecovery(exec: PhaseExecution): boolean {
  if (exec.exitCode !== 0) return true;
  return /(?:^|\n)\s*(?:status:\s*)?(?:failed|unresolved|unable to complete|could not complete)\b/im.test(
    exec.output,
  );
}

export async function orchestrate(
  task: string,
  config: RouterConfig,
  options: {
    dryRun?: boolean;
    explain?: boolean;
    session?: SessionState;
    logLevel?: LogLevel;
    askUser?: (question: string) => Promise<string>;
    routePreferences?: Pick<RouteOverrides, "agent" | "tier">;
    routeOverrides?: RouteOverrides;
  } = {},
): Promise<{ runId: string; phases: PhaseExecution[]; exitCode: number }> {
  const runId = newRunId();
  const routedTask = options.session
    ? `${compactSessionContext(options.session)}\n\nCurrent follow-up request: ${task}`
    : task;
  const logger = new RunLogger({
    runId,
    sessionId: options.session?.sessionId,
    level: options.logLevel ?? config.logging.level,
    persist: config.logging.persist && !options.dryRun,
  });
  let plans = planPhases(task, config);
  const executions: PhaseExecution[] = [];
  /** Providers that already failed for provider-level reasons during this run. */
  const ruledOut = new Set<Agent>();

  if (options.dryRun) {
    console.log(
      `${statusIcon("info")} ${brand()} ${ui.bold("adaptive plan")} ${ui.cyan(runId)} ${ui.gray("·")} ${ui.bold(String(plans.length))} ${ui.gray("phase(s)")}`,
    );
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      let route = applyRoutePreferences(
        applyPhasePreference(routeTask(task, config), p, config),
        options.routePreferences ?? {},
        config,
      );
      route = applyRouteOverrides(route, options.routeOverrides ?? {}, config);
      console.log(
        `  ${ui.gray(String(i + 1).padStart(2) + ".")} ${ui.bold(p.kind.padEnd(9))} ${ui.cyan("→")} ${agentColor(route.agent, route.agent)}${ui.gray("/")}${ui.cyan(route.model)} ${ui.gray("effort=")}${ui.magenta(route.effort)} ${ui.gray("tier=")}${tierColor(route.modelTier)} ${ui.gray("—")} ${p.title}`,
      );
      if (options.explain) {
        for (const reason of route.modelReasons) console.log(`     ${ui.gray("·")} ${reason}`);
        console.log(
          `     ${ui.gray("·")} learning confidence ${((route.learningConfidence ?? 0) * 100).toFixed(0)}%${route.expectedUtility === undefined ? "" : ` · expected utility ${route.expectedUtility.toFixed(2)}`}`,
        );
      }
    }
    return { runId, phases: [], exitCode: 0 };
  }

  logger.status(`adaptive run ${runId} started: ${plans.length} phase(s)`);
  logger.metadata(`cwd=${process.cwd()} session=${options.session?.sessionId ?? "none"}`);

  for (let i = 0; i < plans.length && i < config.orchestration.maxPhases; i++) {
    const p = plans[i];
    const prompt = phaseTask(routedTask, p, executions);
    let route = applyRoutePreferences(
      applyPhasePreference(routeTask(task, config), p, config),
      options.routePreferences ?? {},
      config,
    );
    route = applyRouteOverrides(route, options.routeOverrides ?? {}, config);
    route = fallbackIfMissing(route, config, ruledOut);

    const logMeta = {
      phaseIndex: i + 1,
      phaseTotal: plans.length,
      phaseKind: p.kind,
      agent: route.agent,
      model: route.model,
      effort: route.effort,
      tier: route.modelTier,
    };
    logger.phaseStart(logMeta);
    const started = Date.now();
    let effectivePrompt = prompt;
    let providersExhausted = false;
    let result = await runAgent(route, effectivePrompt, config, {
      headless: true,
      capture: true,
      logger,
      logMeta,
    });
    // A question means the provider is asking for input, not reporting that it
    // cannot serve the run, so it must not trigger a provider switch.
    if (!result.question && isProviderUnavailableError(result.output, result.exitCode)) {
      const failure = providerFailureReason(result.output, result.exitCode);
      // Never spend another phase on a provider that cannot serve this run —
      // unless the user pinned it, in which case later phases keep using it.
      if (!route.agentPinned) ruledOut.add(route.agent);
      const fallback = fallbackProvider(route, config, failure, ruledOut);
      if (fallback) {
        const message = `${route.agent} ${failure} failure detected → falling back to ${fallback.agent}/${fallback.model}`;
        route = fallback;
        Object.assign(logMeta, { agent: route.agent, model: route.model, effort: route.effort });
        logger.providerSwitch(logMeta, message);
        result = await runAgent(route, effectivePrompt, config, {
          headless: true,
          capture: true,
          logger,
          logMeta,
        });
        if (!result.question && isProviderUnavailableError(result.output, result.exitCode)) {
          const fallbackFailure = providerFailureReason(result.output, result.exitCode);
          ruledOut.add(route.agent);
          providersExhausted = true;
          result = { ...result, exitCode: result.exitCode || 1 };
          logger.status(
            `${route.agent} ${fallbackFailure} failure detected → no provider remains available`,
          );
        }
      } else if (route.agentPinned) {
        logger.status(
          `${route.agent} ${failure} failure detected → keeping the explicitly selected provider (no fallback)`,
        );
      } else {
        providersExhausted = true;
        result = { ...result, exitCode: result.exitCode || 1 };
        logger.status(
          `${route.agent} ${failure} failure detected → no other provider is available to take over`,
        );
      }
    }
    let usage = result.usage;
    let clarificationCount = 0;
    while (result.question && options.askUser && clarificationCount < 4) {
      clarificationCount++;
      logger.question(result.question);
      const answer = (await options.askUser(result.question)).trim();
      const elevated = isPermissionApproval(result.question, answer);
      logger.status(
        elevated
          ? `approval received → resuming ${p.kind} with elevated permissions`
          : `input received → resuming ${p.kind}`,
      );
      effectivePrompt = `${prompt}\n\n${elevated ? "[PERMISSION APPROVED: User granted elevated access]\n\n" : ""}The previous attempt paused for clarification.\nQuestion: ${result.question}\nUser answer: ${answer}\n\nContinue the same phase using this answer. Do not repeat the question unless another genuinely blocking decision is required.`;
      result = await runAgent(route, effectivePrompt, config, {
        headless: true,
        capture: true,
        logger,
        logMeta,
        elevated,
      });
      usage = addTokenUsage(usage, result.usage);
    }
    if (result.question) {
      logger.status(
        `${p.kind} remains blocked after ${clarificationCount} clarification attempt(s)`,
      );
      result = { ...result, exitCode: result.exitCode || 1 };
    }
    const execution: PhaseExecution = {
      phase: p,
      route,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      output: result.output,
      usage,
    };
    executions.push(execution);
    logger.phaseEnd(logMeta, result.exitCode, execution.durationMs);

    const recordId = newHistoryId();
    execution.historyId = recordId;
    const assessment = evaluateRoute(result.output, result.exitCode, p.kind, {
      retries: clarificationCount,
      recoveries: p.kind === "recover" ? 1 : 0,
      durationMs: execution.durationMs,
      usage,
    });
    appendHistory(config.history, {
      id: recordId,
      runId,
      sessionId: options.session?.sessionId,
      parentRunId: options.session?.turns.at(-1)?.runId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      task: prompt,
      originalTask: task,
      phaseKind: p.kind,
      phaseIndex: i + 1,
      agent: route.agent,
      modelTier: route.modelTier,
      model: route.model,
      effort: route.effort,
      complexity: route.complexity,
      exitCode: result.exitCode,
      durationMs: execution.durationMs,
      outputExcerpt: tail(result.output, config.orchestration.outputTailChars),
      usage,
      taskFeatures: extractTaskFeatures(task, route.complexity),
      ...assessment,
    });

    // A later independent review can supply delayed evidence about the implementation route.
    if (p.kind === "review" && assessment.outcome.regressions > 0) {
      const implementation = [...executions]
        .reverse()
        .find((candidate) => candidate.phase.kind === "implement" && candidate.historyId);
      if (implementation?.historyId)
        updateHistoryRecord(config.history, implementation.historyId, (record) => ({
          ...record,
          evaluation: record.evaluation
            ? {
                ...record.evaluation,
                taskSatisfied: false,
                quality: Math.max(0, record.evaluation.quality - 0.3),
                signals: [
                  ...record.evaluation.signals,
                  "later review reported a possible regression",
                ],
              }
            : record.evaluation,
          outcome: record.outcome
            ? { ...record.outcome, regressions: record.outcome.regressions + 1 }
            : record.outcome,
        }));
    }

    if (result.question || providersExhausted) break;

    if (
      needsRecovery(execution) &&
      config.orchestration.recoverOnFailure &&
      plans.length < config.orchestration.maxPhases
    ) {
      const recovery = phase(
        `recover-${i}`,
        "recover",
        "Escalated recovery",
        "The previous phase failed or reported an unresolved problem. Diagnose the failure using the current working tree and command output, fix the root cause if it is within scope, and run the smallest validation needed to prove recovery.",
        "claude",
        "deep",
        "high",
      );
      plans.splice(i + 1, 0, recovery);
      logger.status("unresolved/failing phase detected → inserted deep recovery phase");
    }

    if (
      result.exitCode !== 0 &&
      config.orchestration.stopOnFailure &&
      !config.orchestration.recoverOnFailure
    )
      break;
  }

  const exitCode = executions.some((e) => e.exitCode !== 0) ? 1 : 0;
  const finalExecution = [...executions].reverse().find((e) => e.output.trim().length > 0);
  logger.status(`adaptive run ${runId} complete exit=${exitCode}`);
  if (finalExecution) logger.finalOutput(finalExecution.output, exitCode === 0);
  if (logger.persist) logger.status(`logs: ${logger.runDir}`);
  return { runId, phases: executions, exitCode };
}
