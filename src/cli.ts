#!/usr/bin/env node
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import {
  agentColor,
  brand,
  command as commandColor,
  divider,
  panel,
  promptLabel,
  statusIcon,
  tierColor,
  ui,
} from "./ui.js";
import fs from "node:fs";
import { loadConfig, writeProjectConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { printModels } from "./models.js";
import { catalogAge, discoverCatalog } from "./catalog.js";
import {
  appendHistory,
  explainLearning,
  historyPath,
  learningStatus,
  newHistoryId,
  readHistory,
  resetLearning,
  recordImplicitCorrection,
  setScopedFeedback,
} from "./history.js";
import {
  applyRouteOverrides,
  applyRoutePreferences,
  fallbackIfMissing,
  fallbackProvider,
  orchestrate,
  providerFailureReason,
  shouldOrchestrate,
} from "./orchestrator.js";
import { agentForModel, routeTask, routingClarification } from "./router.js";
import {
  addTokenUsage,
  commandExists,
  commandVersion,
  isPermissionApproval,
  runAgent,
} from "./runner.js";
import {
  appendTurn,
  clearActiveSession,
  createSession,
  getActiveSession,
  listSessions,
  loadSession,
  loadSessionTranscript,
  setActiveSession,
} from "./session.js";
import { findRunLogs, followFile, logsRoot, recentRunDirs, RunLogger } from "./logging.js";
import type { Agent, Effort, FeedbackRating, LogLevel, ModelTier, SessionState } from "./types.js";
import { VERSION } from "./version.js";
import {
  cleanDroppedPath,
  INTERACTIVE_COMMANDS,
  isSupportedAttachmentPath,
  parseInteractiveInput,
  taskArgs,
  type InteractivePreferences,
} from "./interactive.js";
import { migrateLegacyPaths } from "./paths.js";
import { shouldRunInitialSetup, shouldShowWelcome } from "./startup.js";
import { singleRunPrompt } from "./prompts.js";
import { inspectAccounts } from "./account.js";
import { AGENTS } from "./providers.js";
import { buildUsageReport, nonCachedTokens, processedTokens } from "./usage.js";
import { firstRunWelcome } from "./welcome.js";
import { auditProviderSupport } from "./provider-support.js";
import { exportLearningArchive, importLearningArchive } from "./history-archive.js";
import { linkRepositoryIdentity, resolveRepositoryIdentity } from "./repository.js";
import pathModule from "node:path";
import { evaluateRoute, extractTaskFeatures } from "./evaluation.js";
import {
  deleteCloudData,
  enableSync,
  exportCloudData,
  syncDevices,
  syncLogin,
  syncLogout,
  syncNow,
  syncPassphrase,
  syncRevokeDevice,
  syncStatePath,
  syncStatus,
} from "./sync.js";
import {
  disableJev,
  enableJev,
  evaluateRunWithJev,
  isJevEnabled,
  JEV_DISCLOSURE,
  JEV_MODEL,
  jevConsentPath,
  jevFeedbackPath,
  readJevConsent,
  readJevFeedback,
  resetJevFeedback,
} from "./jev-feedback.js";

function requireText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function help() {
  console.log("");
  console.log(divider(`AIRO v${VERSION}`));
  console.log(`${brand()} ${ui.dim("Adaptive Intelligence Routing & Orchestration")}`);
  console.log("");
  console.log(ui.bold("Core"));
  console.log(
    `  ${commandColor("airo")}                                   ${ui.gray("open the interactive workspace")}`,
  );
  console.log(
    `  ${commandColor('airo "task"')}                            ${ui.gray("new logical session")}`,
  );
  console.log(
    `  ${commandColor('airo --continue "follow-up"')}             ${ui.gray("continue active repo session")}`,
  );
  console.log(
    `  ${commandColor("airo chat")}                               ${ui.gray("interactive follow-up mode")}`,
  );
  console.log(
    `  ${commandColor('airo --adaptive "task"')}                 ${ui.gray("force multi-phase orchestration")}`,
  );
  console.log(
    `  ${commandColor('airo --single "task"')}                   ${ui.gray("force one agent/model")}`,
  );
  console.log("");
  console.log(ui.bold("Models & setup"));
  console.log(
    `  ${commandColor("airo setup")}                              ${ui.gray("configure the three automatic model tiers")}`,
  );
  console.log(
    `  ${commandColor("airo models")}                             ${ui.gray("show active model mapping")}`,
  );
  console.log(
    `  ${commandColor("airo doctor")}                             ${ui.gray("check providers and paths")}`,
  );
  console.log(
    `  ${commandColor("airo account")}                            ${ui.gray("show provider login and default models")}`,
  );
  console.log("");
  console.log(ui.bold("Observability"));
  console.log(
    `  ${commandColor("airo logs [runId]")}                       ${ui.gray("show persisted logs")}`,
  );
  console.log(
    `  ${commandColor("airo logs --follow [runId]")}              ${ui.gray("follow a run live")}`,
  );
  console.log(
    `  ${commandColor("airo history [limit]")}                    ${ui.gray("show routing history")}`,
  );
  console.log(
    `  ${commandColor("airo history export --encrypted <file>")}  ${ui.gray("export portable learning evidence")}`,
  );
  console.log(
    `  ${commandColor("airo history import <file>")}              ${ui.gray("merge a portable learning archive")}`,
  );
  console.log(
    `  ${commandColor("airo repository id|link <id>")}            ${ui.gray("inspect or link the learning scope")}`,
  );
  console.log(
    `  ${commandColor("airo usage [limit]")}                      ${ui.gray("show token use and measured savings")}`,
  );
  console.log(
    `  ${commandColor("airo feedback good|bad ...")}              ${ui.gray("rate the latest run")}`,
  );
  console.log(
    `  ${commandColor("airo feedback jev status|enable|disable")}  ${ui.gray("control optional local Jev feedback")}`,
  );
  console.log(
    `  ${commandColor("airo learning status|explain|reset")}       ${ui.gray("inspect or reset adaptive routing")}`,
  );
  console.log(
    `  ${commandColor("airo sync login|enable|now|status")}        ${ui.gray("manage optional encrypted cloud sync")}`,
  );
  console.log("");
  console.log(ui.bold("Sessions"));
  console.log(
    `  ${commandColor("airo session")}                            ${ui.gray("show active session")}`,
  );
  console.log(
    `  ${commandColor("airo sessions")}                           ${ui.gray("list repo sessions")}`,
  );
  console.log(
    `  ${commandColor('airo session new ["task"]')}              ${ui.gray("start fresh")}`,
  );
  console.log(
    `  ${commandColor("airo session clear")}                      ${ui.gray("clear active session")}`,
  );
  console.log("");
  console.log(
    `${statusIcon("info")} ${ui.dim("Follow-ups preserve session context but are re-routed independently.")}`,
  );
  console.log(`${statusIcon("info")} ${ui.dim("Set NO_COLOR=1 to disable ANSI colors.")}`);
}

function archivePassphrase(args: string[]): string {
  const passphraseFileIndex = args.indexOf("--passphrase-file");
  if (passphraseFileIndex >= 0) {
    const file = args[passphraseFileIndex + 1];
    if (!file) throw new Error("--passphrase-file requires a path.");
    return fs.readFileSync(pathModule.resolve(file), "utf8").replace(/[\r\n]+$/, "");
  }
  const passphrase = process.env.AIRO_ARCHIVE_PASSPHRASE;
  if (!passphrase)
    throw new Error(
      "Set AIRO_ARCHIVE_PASSPHRASE or use --passphrase-file. Passphrases are never accepted as command arguments.",
    );
  return passphrase;
}

function parseArgs(argv: string[]) {
  let agent: "auto" | Agent = "auto";
  let tier: ModelTier | undefined;
  let preferredAgent: Agent | undefined;
  let preferredTier: ModelTier | undefined;
  let model: string | undefined;
  let effort: Effort | undefined;
  let dryRun = false,
    explain = false,
    adaptive = false,
    single = false,
    continueMode = false,
    noJev = false;
  let logLevel: LogLevel | undefined;
  let sessionId: string | undefined;
  const taskParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") agent = argv[++i] as any;
    else if (arg === "--tier") tier = argv[++i] as ModelTier;
    else if (arg === "--prefer-agent") preferredAgent = argv[++i] as Agent;
    else if (arg === "--prefer-tier") preferredTier = argv[++i] as ModelTier;
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--effort") effort = argv[++i] as Effort;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--explain") explain = true;
    else if (arg === "--adaptive") adaptive = true;
    else if (arg === "--single") single = true;
    else if (arg === "--continue") continueMode = true;
    else if (arg === "--no-jev") noJev = true;
    else if (arg === "--session") sessionId = argv[++i];
    else if (arg === "--log") {
      const v = argv[++i] as LogLevel;
      if (!["compact", "live", "verbose"].includes(v)) throw new Error(`Invalid --log: ${v}`);
      logLevel = v;
    } else if (arg === "-h" || arg === "--help") {
      help();
      process.exit(0);
    } else taskParts.push(arg);
  }
  if (adaptive && single) throw new Error("Use either --adaptive or --single, not both");
  if (!["auto", "claude", "codex", "gemini", "copilot"].includes(agent))
    throw new Error(`Invalid --agent: ${agent}`);
  return {
    agent,
    tier,
    preferredAgent,
    preferredTier,
    model,
    effort,
    dryRun,
    explain,
    adaptive,
    single,
    continueMode,
    noJev,
    sessionId,
    logLevel,
    task: taskParts.join(" ").trim(),
  };
}

async function askTerminal(_question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) =>
      rl.question(`${promptLabel()}${ui.yellow("answer")}: `, resolve),
    );
  } finally {
    rl.close();
  }
}

function showFeedbackOption(config: any, interactive: boolean): void {
  if (!config.history.enabled) return;
  const command = interactive
    ? "/feedback good  |  /feedback bad"
    : "airo feedback good  |  airo feedback bad";
  console.log(`${statusIcon("info")} ${ui.gray("optional feedback:")} ${commandColor(command)}`);
}

function printLearningStatus(config: any): void {
  const status = learningStatus(config.history);
  console.log(divider("Adaptive routing learning"));
  console.log(
    `${ui.bold("Evidence")} ${status.phases} phase(s) · ${status.evaluatedPhases} evaluated · ${status.explicitFeedback} explicit · ${status.implicitFeedback} implicit`,
  );
  if (!status.routes.length) {
    console.log(`${statusIcon("info")} ${ui.gray("No routing observations yet.")}`);
    return;
  }
  for (const route of status.routes.slice(0, 12))
    console.log(
      `${ui.cyan(route.route.padEnd(32))} ${ui.gray(`${route.samples} sample(s)`)} ${ui.bold(`${(route.averageQuality * 100).toFixed(0)}% quality`)}`,
    );
}

function printLearningExplanation(config: any, targetId: string): void {
  const explanation = explainLearning(config.history, targetId);
  console.log(divider(`Learning evidence · ${targetId}`));
  for (const record of explanation.records) {
    const evaluation = record.evaluation;
    console.log(
      `${ui.bold(record.id)} ${agentColor(record.agent, record.agent)}/${ui.cyan(record.model)} ${ui.gray(record.phaseKind ?? "single")} ${evaluation ? ui.bold(`${(evaluation.quality * 100).toFixed(0)}% quality · ${(evaluation.confidence * 100).toFixed(0)}% confidence`) : ui.yellow("legacy/unevaluated")}`,
    );
    for (const signal of evaluation?.signals ?? []) console.log(`  ${ui.gray("·")} ${signal}`);
  }
  for (const feedback of explanation.feedback)
    console.log(
      `${statusIcon("info")} ${feedback.source} ${feedback.scope} feedback: ${feedback.rating}${feedback.note ? ` · ${feedback.note}` : ""}`,
    );
}

function routeOverrides(args: ReturnType<typeof parseArgs>, config: any) {
  const inferredAgent = args.model ? agentForModel(args.model, config) : undefined;
  return {
    agent: args.agent === "auto" ? inferredAgent : args.agent,
    tier: args.tier,
    model: args.model,
    effort: args.effort,
  };
}

function routeWithPreferences(
  route: ReturnType<typeof routeTask>,
  args: ReturnType<typeof parseArgs>,
  config: any,
) {
  return applyRoutePreferences(
    route,
    { agent: args.preferredAgent, tier: args.preferredTier },
    config,
  );
}

async function clarifyRouting(
  args: ReturnType<typeof parseArgs>,
  config: any,
  askUser: (question: string) => Promise<string>,
): Promise<ReturnType<typeof parseArgs>> {
  let task = args.task;
  for (let attempt = 0; attempt < 2; attempt++) {
    const question = routingClarification(task, config);
    if (!question) return task === args.task ? args : { ...args, task };
    new RunLogger({
      runId: `routing-${Date.now().toString(36)}`,
      level: args.logLevel ?? config.logging.level,
      persist: false,
    }).question(question);
    const answer = (await askUser(question)).trim();
    if (!answer)
      throw new Error("A provider, model, tier, or automatic routing choice is required.");
    task = `${args.task}\n\nRouting clarification: ${answer}`;
  }
  const unresolved = routingClarification(task, config);
  if (unresolved) throw new Error(unresolved);
  return { ...args, task };
}

async function singleRun(
  args: ReturnType<typeof parseArgs>,
  config: any,
  path: string | undefined,
  session?: SessionState,
  askUser: (question: string) => Promise<string> = askTerminal,
) {
  let routed = applyRouteOverrides(
    routeWithPreferences(routeTask(args.task, config), args, config),
    routeOverrides(args, config),
    config,
  );
  const singleRunId = `single-${Date.now().toString(36)}`;
  const logger = new RunLogger({
    runId: singleRunId,
    sessionId: session?.sessionId,
    level: args.logLevel ?? config.logging.level,
    persist: config.logging.persist && !args.dryRun,
  });
  const logMeta = {
    phaseIndex: 1,
    phaseTotal: 1,
    phaseKind: "single" as const,
    agent: routed.agent,
    model: routed.model,
    effort: routed.effort,
    tier: routed.modelTier,
  };
  logger.phaseStart(logMeta);
  if (path) console.log(`${statusIcon("info")} ${brand()} ${ui.gray("config")} ${ui.cyan(path)}`);
  if (args.explain || args.dryRun) {
    console.log(
      `${statusIcon("info")} ${ui.bold("provider scores")} ${AGENTS.map((agent) =>
        agentColor(agent, `${agent} ${(routed.agentScores?.[agent] ?? 0).toFixed(1)}`),
      ).join(ui.gray(" / "))}`,
    );
    for (const r of routed.reasons)
      console.log(
        `  ${agentColor(r.agent, r.agent === "claude" ? "C" : "X")} ${ui.yellow(`${r.points >= 0 ? "+" : ""}${r.points.toFixed(1)}`)} ${ui.gray("·")} ${r.reason}`,
      );
    for (const reason of routed.modelReasons)
      console.log(`  ${ui.cyan("M")} ${ui.gray("·")} ${reason}`);
    if (routed.learningConfidence !== undefined)
      console.log(
        `  ${ui.magenta("L")} ${ui.gray("·")} learning confidence ${(routed.learningConfidence * 100).toFixed(0)}%${routed.expectedUtility === undefined ? "" : ` · expected utility ${routed.expectedUtility.toFixed(2)}`}`,
      );
  }
  if (args.dryRun)
    return { exitCode: 0, runId: "dry-run", summaries: [`single:${routed.agent}/${routed.model}`] };
  if (!commandExists(config[routed.agent].command)) {
    const unavailable = routed;
    routed = fallbackIfMissing(routed, config);
    Object.assign(logMeta, { agent: routed.agent, model: routed.model, effort: routed.effort });
    logger.providerSwitch(
      logMeta,
      `${unavailable.agent} is not available in PATH → falling back to ${routed.agent}/${routed.model}`,
    );
  }
  const started = Date.now();
  const basePrompt = singleRunPrompt(args.task, session);
  let effectivePrompt = basePrompt;
  let result = await runAgent(routed, effectivePrompt, config, {
    headless: true,
    capture: true,
    logger,
    logMeta,
  });
  let usage = result.usage;
  const ruledOut = new Set<Agent>();
  // A question means the provider wants input, not that it cannot serve the run.
  while (!result.question) {
    const failure = providerFailureReason(routed.agent, result.output, result.exitCode);
    if (!failure) break;
    if (routed.agentPinned) {
      logger.status(
        `${routed.agent} ${failure} failure detected → keeping the explicitly selected provider (no fallback)`,
      );
      break;
    }
    ruledOut.add(routed.agent);
    const fallback = fallbackProvider(routed, config, failure, ruledOut);
    if (!fallback) {
      logger.status(
        `${routed.agent} ${failure} failure detected → no other provider is available to take over`,
      );
      break;
    }
    const message = `${routed.agent} ${failure} failure detected → falling back to ${fallback.agent}/${fallback.model}`;
    routed = fallback;
    Object.assign(logMeta, { agent: routed.agent, model: routed.model, effort: routed.effort });
    logger.providerSwitch(logMeta, message);
    result = await runAgent(routed, effectivePrompt, config, {
      headless: true,
      capture: true,
      logger,
      logMeta,
    });
    usage = addTokenUsage(usage, result.usage);
  }
  let clarificationCount = 0;
  while (result.question && clarificationCount < 4) {
    clarificationCount++;
    logger.question(result.question);
    const answer = await askUser(result.question);
    const elevated = isPermissionApproval(result.question, answer);
    logger.status(
      elevated
        ? "approval received → resuming single phase with elevated permissions"
        : "input received → resuming single phase",
    );
    effectivePrompt = `${basePrompt}\n\n${elevated ? "[PERMISSION APPROVED: User granted elevated access]\n\n" : ""}Previous clarification question: ${result.question}\nUser answer: ${answer}\n\nContinue the task using this answer. If another blocking decision is required, use AIROUTE_QUESTION: <question>.`;
    result = await runAgent(routed, effectivePrompt, config, {
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
      `single phase remains blocked after ${clarificationCount} clarification attempt(s)`,
    );
    result = { ...result, exitCode: result.exitCode || 1 };
  }
  const durationMs = Date.now() - started;
  logger.phaseEnd(logMeta, result.exitCode, durationMs);
  logger.finalOutput(result.output, result.exitCode === 0);
  if (logger.persist) logger.status(`logs: ${logger.runDir}`);
  const assessment = evaluateRoute(result.output, result.exitCode, undefined, {
    retries: clarificationCount,
    durationMs,
    usage,
  });
  appendHistory(config.history, {
    id: newHistoryId(),
    runId: singleRunId,
    sessionId: session?.sessionId,
    parentRunId: session?.turns.at(-1)?.runId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    task: args.task,
    originalTask: args.task,
    agent: routed.agent,
    modelTier: routed.modelTier,
    model: routed.model,
    effort: routed.effort,
    complexity: routed.complexity,
    routingPolicyVersion: routed.routingPolicyVersion,
    exitCode: result.exitCode,
    durationMs,
    outputExcerpt: result.output.slice(-config.orchestration.outputTailChars),
    usage,
    taskFeatures: extractTaskFeatures(args.task, routed.complexity),
    ...assessment,
  });
  return {
    exitCode: result.exitCode,
    runId: singleRunId,
    output: result.output,
    summaries: [`single:${routed.agent}/${routed.model} exit=${result.exitCode}`],
  };
}

async function execute(
  args: ReturnType<typeof parseArgs>,
  session: SessionState | undefined,
  config: any,
  path?: string,
  askUser: (question: string) => Promise<string> = askTerminal,
) {
  if (!args.dryRun)
    recordImplicitCorrection(config.history, session?.turns.at(-1)?.runId, args.task);
  args = await clarifyRouting(args, config, askUser);
  const adaptive = args.adaptive || (!args.single && shouldOrchestrate(args.task, config));
  if (adaptive) {
    const result = await orchestrate(args.task, config, {
      dryRun: args.dryRun,
      explain: args.explain,
      session,
      logLevel: args.logLevel,
      askUser,
      routePreferences: { agent: args.preferredAgent, tier: args.preferredTier },
      routeOverrides: routeOverrides(args, config),
    });
    if (!args.dryRun && !args.noJev && config.permissions.networkAccess) {
      const feedback = await evaluateRunWithJev(config.history, result.runId);
      if (feedback.status === "saved")
        console.log(
          `${statusIcon("ok")} ${ui.gray("Jev feedback saved locally for")} ${ui.bold(String(feedback.records.length))} ${ui.gray("phase(s)")}`,
        );
      else if (feedback.status === "error")
        console.error(
          `${statusIcon("error")} ${ui.yellow(`${feedback.reason}; run result is unchanged`)}`,
        );
    }
    if (session && !args.dryRun)
      appendTurn(session, {
        turnId: result.runId + "-turn",
        runId: result.runId,
        timestamp: new Date().toISOString(),
        userPrompt: args.task,
        routeSummary: result.phases
          .map((p) => `${p.phase.kind}:${p.route.agent}/${p.route.model}`)
          .join(" → "),
        phaseSummaries: result.phases.map(
          (p) => `${p.phase.kind} exit=${p.exitCode}; ${p.output.replace(/\s+/g, " ").slice(-400)}`,
        ),
      });
    if (!args.dryRun) showFeedbackOption(config, Boolean(session));
    return result.exitCode;
  }
  const r = await singleRun(args, config, path, session, askUser);
  if (!args.dryRun && !args.noJev && config.permissions.networkAccess) {
    const feedback = await evaluateRunWithJev(config.history, r.runId);
    if (feedback.status === "saved")
      console.log(`${statusIcon("ok")} ${ui.gray("Jev feedback saved locally")}`);
    else if (feedback.status === "error")
      console.error(
        `${statusIcon("error")} ${ui.yellow(`${feedback.reason}; run result is unchanged`)}`,
      );
  }
  if (session && !args.dryRun)
    appendTurn(session, {
      turnId: r.runId + "-turn",
      runId: r.runId,
      timestamp: new Date().toISOString(),
      userPrompt: args.task,
      routeSummary: r.summaries[0] ?? "single",
      phaseSummaries: r.summaries,
    });
  if (!args.dryRun) showFeedbackOption(config, Boolean(session));
  return r.exitCode;
}

export function interactivePrompt(
  session: SessionState,
  preferences: InteractivePreferences,
): string {
  const mode =
    preferences.mode === "auto"
      ? ui.green("auto")
      : preferences.mode === "adaptive"
        ? ui.magenta("adaptive")
        : ui.yellow("single");
  const agent =
    preferences.agent === "auto"
      ? ui.gray("auto-agent")
      : agentColor(preferences.agent, preferences.agent);
  const repo = pathModule.basename(process.cwd());
  let branch = "detached";
  try {
    branch =
      execFileSync("git", ["branch", "--show-current"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "detached";
  } catch {
    // The prompt should remain usable outside a Git repository.
  }
  return `${brand()} ${ui.gray(session.sessionId.slice(0, 6))} ${ui.gray(`${repo}:${branch}`)} ${mode} ${agent} ${ui.green("❯")} `;
}

function interactiveStatus(
  session: SessionState,
  preferences: InteractivePreferences,
  config: any,
  path?: string,
): string {
  const provider = (agent: Agent) => {
    const available = commandExists(config[agent].command);
    return `${available ? statusIcon("ok") : statusIcon("error")} ${agentColor(agent, agent.padEnd(6))} ${ui.gray(config[agent].models.balanced.model)}`;
  };
  return panel(`AIRO v${VERSION}`, [
    `${ui.bold("session")}  ${ui.cyan(session.sessionId)} ${ui.gray(`· ${session.turns.length} turn(s)`)}`,
    `${ui.bold("mode")}     ${ui.cyan(preferences.mode)} ${ui.gray("·")} ${ui.bold("agent")} ${ui.cyan(preferences.agent)} ${ui.gray("·")} ${ui.bold("tier")} ${tierColor(preferences.tier ?? "auto")}`,
    `${ui.bold("output")}   ${ui.cyan(preferences.logLevel)} ${ui.gray("· config ")} ${path ? ui.cyan(path) : ui.yellow("defaults")}`,
    `${ui.bold("models")}   ${ui.gray("balanced ·")} ${provider("claude")}    ${provider("codex")}`,
  ]);
}

function interactiveHelp(): string {
  return panel(
    "Interactive commands",
    [
      `${commandColor("/new [title]")}        ${ui.gray("start a fresh session")}`,
      `${commandColor("/status")}             ${ui.gray("show session and run preferences")}`,
      `${commandColor("/mode auto|adaptive|single")} ${ui.gray("set workflow mode")}`,
      `${commandColor("/agent auto|claude|codex|gemini|copilot")} ${ui.gray("pin or auto-select a provider")}`,
      `${commandColor("/tier auto|fast|balanced|deep")} ${ui.gray("set model tier")}`,
      `${commandColor("/log compact|live|verbose")}  ${ui.gray("set output detail")}`,
      `${commandColor("/models")}             ${ui.gray("show active model mapping")}`,
      `${commandColor("/account")}            ${ui.gray("show provider accounts")}`,
      `${commandColor("/usage [limit]")}      ${ui.gray("show token usage")}`,
      `${commandColor("/logs")}               ${ui.gray("show recent run logs")}`,
      `${commandColor("/attach <file-path>")} ${ui.gray("attach a local image, PDF, Markdown, or JSON file to the next task")}`,
      `${commandColor("/feedback good|bad [note]")} ${ui.gray("rate the latest run")}`,
      `${commandColor("/feedback phase <id> good|bad [note]")} ${ui.gray("rate one phase")}`,
      `${commandColor("/learning status|explain <id>")} ${ui.gray("inspect learned routing")}`,
      `${commandColor("/sessions")}           ${ui.gray("list repository sessions")}`,
      `${commandColor("/clear")}              ${ui.gray("clear the screen")}`,
      `${commandColor("/exit")}               ${ui.gray("exit interactive mode")}`,
    ],
    76,
  );
}

async function chatLoop(config: any, path?: string) {
  let session: SessionState = getActiveSession() ?? createSession("Interactive session");
  let attachments: string[] = [];
  const preferences: InteractivePreferences = {
    mode: "auto",
    agent: "auto",
    logLevel: config.logging.level,
  };
  console.log("");
  console.log(interactiveStatus(session, preferences, config, path));
  console.log(
    `${ui.gray("Type a task to begin, or")} ${commandColor("/help")} ${ui.gray("for interactive commands.")}`,
  );
  console.log("");
  const completer = (line: string) => {
    if (!line.startsWith("/")) return [[], line];
    const hits = INTERACTIVE_COMMANDS.filter((command) => command.startsWith(line));
    return [hits.length ? hits : INTERACTIVE_COMMANDS, line];
  };
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    historySize: 200,
    removeHistoryDuplicates: true,
  });
  const ask = () =>
    new Promise<string>((resolve) => rl.question(interactivePrompt(session, preferences), resolve));
  const askAnswer = (_question: string) =>
    new Promise<string>((resolve) =>
      rl.question(`${promptLabel()}${ui.yellow("answer")}: `, resolve),
    );
  try {
    while (true) {
      let action = parseInteractiveInput(await ask());
      if (action.kind === "empty") continue;
      if (action.kind === "quit") break;
      if (action.kind === "help") {
        console.log(interactiveHelp());
        continue;
      }
      if (action.kind === "status") {
        console.log(interactiveStatus(session, preferences, config, path));
        continue;
      }
      if (action.kind === "clear") {
        process.stdout.write(process.stdout.isTTY ? "\x1b[2J\x1b[H" : "\n");
        continue;
      }
      if (action.kind === "models") {
        await printModels();
        continue;
      }
      if (action.kind === "account") {
        console.log(
          panel(
            "Provider accounts",
            inspectAccounts(config).map((account) => {
              const icon =
                account.available && account.authenticated === true
                  ? statusIcon("ok")
                  : account.available && account.authenticated === undefined
                    ? statusIcon("info")
                    : statusIcon("error");
              const identity =
                account.identity ??
                (account.authenticated === true ? "identity not exposed by CLI" : account.status);
              return `${icon} ${agentColor(account.agent, account.agent.padEnd(6))} ${ui.bold(identity)} ${ui.gray(`· default ${account.defaultModel ?? "not detected"}`)}`;
            }),
          ),
        );
        continue;
      }
      if (action.kind === "usage") {
        const report = buildUsageReport(config, action.limit ?? 20);
        console.log(
          panel(`Token usage · last ${report.records.length} measured phase(s)`, [
            `${ui.bold("Non-cached")} ${ui.cyan(nonCachedTokens(report.totals).toLocaleString())} tokens`,
            `${ui.bold("Cache reads")} ${ui.cyan(report.totals.cachedInputTokens.toLocaleString())} tokens`,
            `${ui.bold("Processed")} ${ui.cyan(processedTokens(report.totals).toLocaleString())} tokens`,
          ]),
        );
        continue;
      }
      if (action.kind === "logs") {
        const runs = recentRunDirs(20);
        console.log(
          panel(
            "Recent run logs",
            runs.length
              ? runs.map(
                  (run) =>
                    `${ui.bold(run.runId)} ${ui.gray(run.mtime.toISOString())} ${ui.cyan(run.path)}`,
                )
              : [ui.gray("No logs yet.")],
          ),
        );
        continue;
      }
      if (action.kind === "attach") {
        const attachmentPath = pathModule.resolve(
          action.path.replace(/^~/, process.env.HOME ?? "~"),
        );
        try {
          const stat = fs.statSync(attachmentPath);
          if (!stat.isFile()) throw new Error("not a file");
          if (!isSupportedAttachmentPath(attachmentPath))
            throw new Error("unsupported file extension");
          attachments.push(attachmentPath);
          console.log(
            `${statusIcon("ok")} ${ui.gray("attached file")} ${ui.cyan(attachmentPath)} ${ui.dim("(will be included with the next task)")}`,
          );
        } catch (error) {
          console.log(
            `${statusIcon("error")} ${ui.red(`Cannot attach file: ${error instanceof Error ? error.message : String(error)}`)}`,
          );
        }
        continue;
      }
      if (action.kind === "feedback") {
        const updated = setScopedFeedback(config.history, action.rating, {
          scope: action.phaseId ? "phase" : "run",
          targetId: action.phaseId,
          note: action.note,
        });
        console.log(
          `${statusIcon("ok")} ${ui.gray("feedback saved for")} ${ui.bold(updated.scope)} ${ui.cyan(updated.targetId)}`,
        );
        continue;
      }
      if (action.kind === "learning") {
        if (action.action === "status") printLearningStatus(config);
        else if (action.action === "explain") printLearningExplanation(config, action.targetId!);
        else if (!action.confirmed)
          console.log(
            `${statusIcon("info")} ${ui.yellow("Use /learning reset --yes to remove ordinary learned feedback; Jev evidence has its own reset command.")}`,
          );
        else
          console.log(
            `${statusIcon("ok")} ${ui.gray("removed")} ${ui.bold(String(resetLearning(config.history)))} ${ui.gray("feedback record(s)")}`,
          );
        continue;
      }
      if (action.kind === "sessions") {
        const sessions = listSessions();
        console.log(
          panel(
            "Repository sessions",
            sessions.length
              ? sessions
                  .slice(0, 8)
                  .map(
                    (item) =>
                      `${item.sessionId === session.sessionId ? statusIcon("ok") : " "} ${ui.bold(item.sessionId)} ${ui.gray(`· ${item.turns.length} turns · ${item.originalTask}`)}`,
                  )
              : [ui.gray("No sessions for this repository.")],
          ),
        );
        continue;
      }
      if (action.kind === "new") {
        session = createSession(action.title ?? "Interactive session");
        console.log(
          `${statusIcon("ok")} ${ui.green("new session")} ${ui.bold(session.sessionId)}${action.title ? ui.gray(` · ${action.title}`) : ""}`,
        );
        continue;
      }
      if (action.kind === "set-mode") preferences.mode = action.value;
      else if (action.kind === "set-agent") preferences.agent = action.value;
      else if (action.kind === "set-tier") preferences.tier = action.value;
      else if (action.kind === "set-log") preferences.logLevel = action.value;
      else if (action.kind === "error") {
        console.log(`${statusIcon("error")} ${ui.red(action.message)}`);
        continue;
      } else if (action.kind === "task") {
        // Terminals usually paste a dropped file as one path (sometimes quoted).
        const droppedPath = cleanDroppedPath(action.task);
        if (isSupportedAttachmentPath(droppedPath)) {
          const attachmentPath = pathModule.resolve(
            droppedPath.replace(/^~/, process.env.HOME ?? "~"),
          );
          try {
            if (!fs.statSync(attachmentPath).isFile()) throw new Error("not a file");
            attachments.push(attachmentPath);
            console.log(
              `${statusIcon("ok")} ${ui.gray("attached dropped file")} ${ui.cyan(attachmentPath)}`,
            );
            action = { kind: "task", task: "Inspect the attached file" };
          } catch {
            // A normal task ending in a filename should still be routed normally.
          }
        }
        const attachmentContext = attachments.length
          ? `\n\nAttached local file(s) for inspection:\n${attachments.map((file) => `- ${file}`).join("\n")}\nUse the provider's local file inspection capability if available.`
          : "";
        const args = parseArgs(taskArgs(`${action.task}${attachmentContext}`, preferences));
        attachments = [];
        const adaptive = args.adaptive || (!args.single && shouldOrchestrate(args.task, config));
        console.log(
          `${statusIcon("work")} ${ui.gray("workflow")} ${adaptive ? ui.magenta("adaptive") : ui.cyan("single")} ${ui.gray("· preparing run")}`,
        );
        try {
          await execute(args, session, config, path, askAnswer);
          session = loadSession(session.sessionId);
        } catch (error) {
          console.log(
            `${statusIcon("error")} ${ui.red(error instanceof Error ? error.message : String(error))}`,
          );
        }
        continue;
      }
      console.log(
        `${statusIcon("ok")} ${ui.gray("updated preferences ·")} ${ui.cyan(`mode=${preferences.mode} agent=${preferences.agent} tier=${preferences.tier ?? "auto"} log=${preferences.logLevel}`)}`,
      );
    }
  } finally {
    rl.close();
    console.log(`${statusIcon("ok")} ${ui.gray("AIRO session saved. Goodbye.")}`);
  }
}

async function main() {
  const raw = process.argv.slice(2);

  if (raw[0] === "--version" || raw[0] === "-v") {
    console.log(VERSION);
    return;
  }

  const migration = migrateLegacyPaths();
  for (const error of migration.errors)
    console.error(`${statusIcon("error")} ${ui.yellow(`legacy data migration skipped: ${error}`)}`);
  let { config, path } = loadConfig();

  if (shouldShowWelcome(raw, Boolean(process.stdin.isTTY))) {
    console.log(firstRunWelcome(config));
  }

  if (shouldRunInitialSetup(raw, Boolean(process.stdin.isTTY), Boolean(path))) {
    await runSetup();
    ({ config, path } = loadConfig());
  }

  if (raw[0] === "setup") {
    await runSetup();
    return;
  }
  if (raw[0] === "models") {
    await printModels();
    return;
  }

  if (raw[0] === "account") {
    console.log(divider("Provider accounts"));
    for (const account of inspectAccounts(config)) {
      const icon =
        account.available && account.authenticated === true
          ? statusIcon("ok")
          : account.available && account.authenticated === undefined
            ? statusIcon("info")
            : statusIcon("error");
      const identity =
        account.identity ??
        (account.authenticated === true ? "identity not exposed by CLI" : account.status);
      console.log(
        `${icon} ${agentColor(account.agent, account.agent.padEnd(6))} ${ui.bold(identity)}`,
      );
      if (account.authMethod)
        console.log(`  ${ui.gray("authentication")} ${ui.cyan(account.authMethod)}`);
      console.log(
        `  ${ui.gray("default model ")} ${account.defaultModel ? ui.cyan(account.defaultModel) : ui.yellow("not detected; set defaultModel in AIRO config")}`,
      );
      const tiers = (["fast", "balanced", "deep"] as const)
        .map((tier) => `${tier}=${config[account.agent].models[tier].model}`)
        .join(" · ");
      console.log(`  ${ui.gray("AIRO models   ")} ${ui.dim(tiers)}`);
    }
    return;
  }

  if (raw[0] === "doctor") {
    const support = auditProviderSupport(config);
    console.log(divider("Doctor"));
    console.log(`${ui.gray("Config ")} ${path ? ui.cyan(path) : ui.yellow("built-in defaults")}`);
    console.log(`${ui.gray("History")} ${ui.cyan(historyPath(config.history))}`);
    console.log(
      `${support.ready ? statusIcon("ok") : statusIcon("error")} ${ui.gray(`Provider integration contract v${support.contractVersion}`)} ${support.ready ? ui.cyan("ready") : ui.red("incomplete")}`,
    );
    for (const agent of AGENTS) {
      const integration = support.providers.find((provider) => provider.agent === agent)!;
      const command = config[agent].command;
      const exists = commandExists(command);
      console.log(
        `${exists ? statusIcon("ok") : statusIcon("error")} ${agentColor(agent, agent.padEnd(6))} ${ui.cyan(command)} ${exists ? ui.gray(`→ ${commandVersion(command)}`) : ui.red("→ not found in PATH")}`,
      );
      console.log(
        `         ${ui.gray("integration")} ${integration.ready ? ui.cyan("ready") : ui.red("incomplete")}`,
      );
      if (!exists) continue;
      const catalog = await discoverCatalog(agent, config, { refresh: true, online: true });
      console.log(
        `         ${ui.gray("models")} ${
          catalog.source === "builtin"
            ? ui.yellow(`not detected${catalog.note ? ` · ${catalog.note}` : ""}`)
            : `${ui.cyan(String(catalog.models.length))} ${ui.gray(`via ${catalog.via ?? catalog.source} · ${catalogAge(catalog)}`)}`
        }`,
      );
    }
    return;
  }
  if (raw[0] === "sync") {
    const action = raw[1] ?? "status";
    const allowFile = raw.includes("--allow-credential-file");
    if (action === "login") {
      const serverIndex = raw.indexOf("--server");
      const server = serverIndex >= 0 ? raw[serverIndex + 1] : undefined;
      const result = await syncLogin({
        server,
        allowCredentialFile: allowFile,
        onChallenge: (url, code) => {
          console.log(`${statusIcon("info")} Open ${ui.cyan(url)} and enter ${ui.bold(code)}.`);
          console.log(`${ui.gray("Waiting for browser authorization…")}`);
        },
      });
      console.log(
        `${statusIcon("ok")} ${ui.green(`Signed in as ${result.login}`)} ${ui.gray(`· credentials: ${result.credentialStore}`)}`,
      );
      return;
    }
    if (action === "enable") {
      console.log(divider("Encrypted cloud sync"));
      console.log(
        `${statusIcon("info")} ${ui.yellow("Keep your recovery passphrase safe. If it and every authorized device are lost, synchronized data cannot be recovered.")}`,
      );
      console.log(
        `${ui.gray("Provider credentials, API keys, executable paths, local permission settings, and Jev consent never sync.")}`,
      );
      const passphrase = syncPassphrase(raw);
      if (passphrase.source === "argument") {
        console.log(
          `${statusIcon("info")} ${ui.yellow("A command-line passphrase may be retained in shell history or briefly visible to other local processes.")}`,
        );
      }
      await enableSync(passphrase.value, allowFile);
      console.log(`${statusIcon("ok")} ${ui.green("End-to-end encrypted sync enabled.")}`);
      return;
    }
    if (action === "now") {
      const result = await syncNow(config, allowFile);
      console.log(
        `${statusIcon("ok")} ${ui.green("Sync complete")} ${ui.gray(`· ${result.pushed} uploaded · ${result.pulled} merged`)}`,
      );
      return;
    }
    if (action === "status") {
      const result = syncStatus(allowFile);
      console.log(divider("Encrypted cloud sync"));
      console.log(
        `${ui.bold("Status")} ${result.state?.enabled ? ui.green("enabled") : ui.yellow("disabled")}`,
      );
      console.log(`${ui.bold("Server")} ${ui.cyan(result.state?.server ?? "not configured")}`);
      console.log(`${ui.bold("Account")} ${ui.cyan(result.state?.user?.login ?? "signed out")}`);
      console.log(
        `${ui.bold("Credentials")} ${result.credentials ? ui.green(result.credentialStore ?? "available") : ui.yellow("missing")}`,
      );
      console.log(`${ui.bold("Last sync")} ${ui.cyan(result.state?.lastSyncAt ?? "never")}`);
      console.log(`${ui.bold("State")} ${ui.cyan(syncStatePath())}`);
      return;
    }
    if (action === "devices") {
      if (raw[2] === "revoke") {
        if (!raw[3]) throw new Error("Use: airo sync devices revoke <device-id>");
        await syncRevokeDevice(raw[3], allowFile);
        console.log(`${statusIcon("ok")} ${ui.gray("Sync device revoked.")}`);
        return;
      }
      const devices = await syncDevices(allowFile);
      console.log(divider("Sync devices"));
      for (const device of devices) {
        const state = device.revokedAt
          ? ui.red("revoked")
          : device.current
            ? ui.cyan("current")
            : ui.green("authorized");
        console.log(
          `${statusIcon(device.revokedAt ? "error" : device.current ? "ok" : "info")} ${ui.bold(device.name)} ${ui.gray(device.id)} ${state}`,
        );
      }
      return;
    }
    if (action === "export") {
      const output = raw[2];
      if (!output || output.startsWith("--"))
        throw new Error("Use: airo sync export <file> [--force]");
      const file = await exportCloudData(output, {
        allowFile,
        overwrite: raw.includes("--force"),
      });
      console.log(
        `${statusIcon("ok")} ${ui.gray("Cloud account export written:")} ${ui.cyan(file)}`,
      );
      return;
    }
    if (action === "logout") {
      await syncLogout(allowFile);
      console.log(
        `${statusIcon("ok")} ${ui.gray("Signed out and removed local sync credentials.")}`,
      );
      return;
    }
    if (action === "delete-cloud-data") {
      if (!raw.includes("--yes"))
        throw new Error(
          "This permanently deletes synchronized cloud data. Re-run with: airo sync delete-cloud-data --yes",
        );
      await deleteCloudData(allowFile);
      console.log(
        `${statusIcon("ok")} ${ui.gray("Cloud sync account and encrypted data deleted.")}`,
      );
      return;
    }
    throw new Error(
      "Use: airo sync login|enable|now|status|devices|export|logout|delete-cloud-data",
    );
  }
  if (raw[0] === "history") {
    if (raw[1] === "export") {
      const encrypted = raw.indexOf("--encrypted");
      const output = encrypted >= 0 ? raw[encrypted + 1] : undefined;
      if (!output || output.startsWith("--"))
        throw new Error("Use: airo history export --encrypted <archive.airo> [--force]");
      const result = exportLearningArchive(config.history, output, archivePassphrase(raw), {
        overwrite: raw.includes("--force"),
      });
      console.log(
        `${statusIcon("ok")} ${ui.gray("encrypted archive written:")} ${ui.cyan(pathModule.resolve(output))}`,
      );
      console.log(
        `${ui.gray("Evidence")} ${result.history.total} phase(s), ${result.feedback.total} feedback record(s) · digest ${result.evidenceDigest.slice(0, 12)}`,
      );
      return;
    }
    if (raw[1] === "import") {
      const input = raw[2];
      if (!input || input.startsWith("--"))
        throw new Error("Use: airo history import <archive.airo>");
      const result = importLearningArchive(config.history, input, archivePassphrase(raw));
      console.log(
        `${statusIcon("ok")} ${ui.gray("learning evidence merged:")} ${ui.cyan(pathModule.resolve(input))}`,
      );
      console.log(
        `${ui.gray("History")} ${result.history.imported} imported · ${result.history.skipped} already present · ${result.history.total} total`,
      );
      console.log(
        `${ui.gray("Feedback")} ${result.feedback.imported} imported · ${result.feedback.skipped} already present · ${result.feedback.total} total · digest ${result.evidenceDigest.slice(0, 12)}`,
      );
      if (result.backupFiles.length)
        console.log(
          `${ui.gray("Backups")} ${result.backupFiles.map((file) => ui.cyan(file)).join(", ")}`,
        );
      return;
    }
    const limit = Math.max(1, Number(raw[1] ?? 15));
    for (const r of readHistory(config.history).slice(-limit).reverse())
      console.log(
        `${r.id}${r.runId ? ` run=${r.runId}` : ""}${r.sessionId ? ` session=${r.sessionId}` : ""} ${r.agent}/${r.model} ${r.effort} exit=${r.exitCode} ${r.feedback ?? ""}`,
      );
    return;
  }
  if (raw[0] === "repository") {
    const storageDir = pathModule.dirname(historyPath(config.history));
    if (!raw[1] || raw[1] === "id") {
      const identity = resolveRepositoryIdentity(process.cwd(), storageDir);
      console.log(`${identity.id} ${ui.gray(`(${identity.source})`)}`);
    } else if (raw[1] === "link" && raw[2]) {
      linkRepositoryIdentity(process.cwd(), storageDir, raw[2]);
      console.log(`${statusIcon("ok")} ${ui.gray("repository linked to")} ${ui.cyan(raw[2])}`);
    } else throw new Error("Use: airo repository id|link <repository-id>");
    return;
  }
  if (raw[0] === "usage") {
    const limit = Math.max(1, Number(raw[1] ?? 20));
    const report = buildUsageReport(config, limit);
    console.log(divider(`Token usage · last ${report.records.length} measured phase(s)`));
    if (!report.records.length) {
      console.log(
        `${statusIcon("info")} ${ui.gray("No provider token telemetry is available yet. Run a task with persisted logging enabled.")}`,
      );
      return;
    }
    console.log(
      `${ui.bold("Non-cached")} ${ui.cyan(nonCachedTokens(report.totals).toLocaleString())} ${ui.gray("tokens")}`,
    );
    console.log(
      `${ui.bold("Cache reads")} ${ui.cyan(report.totals.cachedInputTokens.toLocaleString())} ${ui.gray("tokens")}`,
    );
    console.log(
      `${ui.bold("Processed")}  ${ui.cyan(processedTokens(report.totals).toLocaleString())} ${ui.gray("tokens")}`,
    );
    console.log(
      `${ui.bold("Output")}     ${ui.cyan(report.totals.outputTokens.toLocaleString())} ${ui.gray("tokens (included above)")}`,
    );
    for (const agent of AGENTS) {
      console.log(
        `${agentColor(agent, agent.padEnd(6))} ${ui.gray("default model")} ${report.defaults[agent] ? ui.cyan(report.defaults[agent]!) : ui.yellow("not detected")}`,
      );
    }
    if (report.savings) {
      const value = Math.abs(report.savings.percent).toFixed(1);
      const comparison =
        report.savings.percent >= 0
          ? `AIRO used ${value}% fewer non-cached tokens`
          : `AIRO used ${value}% more non-cached tokens`;
      console.log(
        `${statusIcon(report.savings.percent >= 0 ? "ok" : "info")} ${ui.bold(comparison)} ${ui.gray("than comparable successful runs on provider-default models.")}`,
      );
      console.log(
        `${ui.gray(`Coverage: ${report.savings.comparedRecords}/${report.savings.totalRecords} measured phase(s). This is a historical estimate, not a same-task A/B test.`)}`,
      );
    } else {
      console.log(
        `${statusIcon("info")} ${ui.gray("Default-model comparison unavailable: at least two comparable measured runs on a detected provider-default model are needed.")}`,
      );
    }
    return;
  }
  if (raw[0] === "feedback") {
    if (raw[1] === "jev") {
      const action = raw[2] ?? "status";
      if (action === "status") {
        const consent = readJevConsent(config.history);
        const enabled = isJevEnabled(config.history);
        console.log(divider("Optional local Jev feedback"));
        console.log(
          `${ui.bold("Status")} ${enabled ? ui.green("enabled") : ui.yellow("disabled")}`,
        );
        console.log(
          `${ui.bold("API key")} ${process.env.TYPESAFE_API_KEY ? ui.green("available in environment") : ui.yellow("not set")}`,
        );
        console.log(`${ui.bold("Model")} ${ui.cyan(JEV_MODEL)}`);
        console.log(
          `${ui.bold("Records")} ${ui.cyan(String(readJevFeedback(config.history).length))}`,
        );
        console.log(`${ui.bold("Consent")} ${ui.cyan(jevConsentPath(config.history))}`);
        console.log(`${ui.bold("Feedback")} ${ui.cyan(jevFeedbackPath(config.history))}`);
        if (consent?.enabled && !enabled)
          console.log(
            `${statusIcon("info")} ${ui.yellow("Consent notice changed; review and enable again before another request.")}`,
          );
        return;
      }
      if (action === "enable") {
        if (!config.history.enabled)
          throw new Error("Enable local history before enabling Jev feedback.");
        console.log(divider("Jev data-sharing consent"));
        for (const line of JEV_DISCLOSURE) console.log(`${ui.gray("•")} ${line}`);
        let accepted = raw.includes("--accept-data-sharing");
        if (!accepted && process.stdin.isTTY) {
          console.log(
            `${statusIcon("info")} ${ui.yellow('Type "ENABLE JEV" to accept this disclosure.')}`,
          );
          accepted = (await askTerminal("Jev consent")) === "ENABLE JEV";
        }
        if (!accepted)
          throw new Error(
            "Consent was not recorded. Review the disclosure and re-run with --accept-data-sharing, or enable interactively.",
          );
        enableJev(config.history);
        console.log(`${statusIcon("ok")} ${ui.green("Optional local Jev feedback enabled.")}`);
        if (!process.env.TYPESAFE_API_KEY)
          console.log(
            `${statusIcon("info")} ${ui.yellow("Set TYPESAFE_API_KEY in your environment before running a task.")}`,
          );
        return;
      }
      if (action === "disable") {
        disableJev(config.history);
        console.log(
          `${statusIcon("ok")} ${ui.gray("Jev feedback disabled; existing local records were preserved.")}`,
        );
        return;
      }
      if (action === "inspect") {
        const limitArg = raw.find((_value: string, index: number) => raw[index - 1] === "--limit");
        const limit = Math.max(1, Number(limitArg ?? 20));
        const records = readJevFeedback(config.history).slice(-limit).reverse();
        console.log(divider("Local Jev feedback"));
        if (!records.length)
          console.log(`${statusIcon("info")} ${ui.gray("No Jev feedback yet.")}`);
        for (const record of records)
          console.log(
            `${record.id} ${record.selected.agent}/${record.selected.tier} → ${record.suggested.agent}/${record.suggested.tier} ${record.acceptedIntoLearning ? ui.green("accepted") : ui.yellow("observed")} ${ui.gray(`confidence=${Math.min(record.provider.confidence, record.tier.confidence).toFixed(2)} model=${record.model}`)}`,
          );
        return;
      }
      if (action === "reset") {
        if (!raw.includes("--yes"))
          throw new Error(
            "Jev reset removes local Jev feedback. Re-run with: airo feedback jev reset --yes",
          );
        console.log(
          `${statusIcon("ok")} ${ui.gray("removed")} ${ui.bold(String(resetJevFeedback(config.history)))} ${ui.gray("Jev feedback record(s); consent was preserved")}`,
        );
        return;
      }
      throw new Error("Use: airo feedback jev status|enable|disable|inspect|reset");
    }
    const phase = raw[1] === "phase";
    const targetId = phase ? raw[2] : undefined;
    const rating = raw[phase ? 3 : 1] as FeedbackRating;
    if (!["good", "bad"].includes(rating)) throw new Error("Use: airo feedback good|bad [note]");
    const updated = setScopedFeedback(config.history, rating, {
      scope: phase ? "phase" : "run",
      targetId,
      note: raw.slice(phase ? 4 : 2).join(" ") || undefined,
    });
    console.log(
      `${statusIcon("ok")} ${brand()} ${ui.gray("feedback=")}${rating === "good" ? ui.green(rating) : ui.red(rating)} ${ui.gray("saved for")} ${ui.bold(updated.scope)} ${ui.cyan(updated.targetId)}`,
    );
    return;
  }
  if (raw[0] === "learning") {
    const action = raw[1] ?? "status";
    if (action === "status") printLearningStatus(config);
    else if (action === "explain" && raw[2]) printLearningExplanation(config, raw[2]);
    else if (action === "reset") {
      if (!raw.includes("--yes"))
        throw new Error(
          "Learning reset removes ordinary feedback-derived learning; Jev evidence has its own reset command. Re-run with: airo learning reset --yes",
        );
      console.log(
        `${statusIcon("ok")} ${ui.gray("removed")} ${ui.bold(String(resetLearning(config.history)))} ${ui.gray("feedback record(s); routing history was preserved")}`,
      );
    } else throw new Error("Use: airo learning status|explain <run-or-phase-id>|reset --yes");
    return;
  }
  if (raw[0] === "config" && raw[1] === "init") {
    console.log(`${statusIcon("ok")} ${ui.green("Created")} ${ui.cyan(writeProjectConfig())}`);
    return;
  }
  if (raw[0] === "logs") {
    const follow = raw.includes("--follow");
    const idArg = raw.slice(1).find((x: string) => x !== "--follow");
    if (!idArg) {
      const runs = recentRunDirs(20);
      if (!runs.length)
        console.log(
          `${statusIcon("info")} ${ui.gray("No logs yet. Root:")} ${ui.cyan(logsRoot())}`,
        );
      for (const r of runs)
        console.log(
          `${statusIcon("info")} ${ui.bold(r.runId)} ${ui.gray(r.mtime.toISOString())} ${ui.cyan(r.path)}`,
        );
      return;
    }
    const dir = findRunLogs(idArg);
    if (!dir) throw new Error(`Run logs not found: ${idArg}`);
    const file = `${dir}/combined.log`;
    if (follow) {
      console.log(
        `${statusIcon("work")} ${brand()} ${ui.gray("following")} ${ui.cyan(file)} ${ui.gray("— Ctrl-C to stop")}`,
      );
      await followFile(file);
    } else {
      console.log(requireText(file));
    }
    return;
  }
  if (raw[0] === "chat" || (raw.length === 0 && process.stdin.isTTY)) {
    await chatLoop(config, path);
    return;
  }
  if (raw[0] === "sessions") {
    const json = raw.includes("--json");
    const limitIndex = raw.findIndex((arg: string) => arg === "--limit");
    const requestedLimit = limitIndex >= 0 ? Number(raw[limitIndex + 1]) : undefined;
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit! > 0 ? requestedLimit : undefined;
    const list = listSessions().slice(0, limit);
    if (json) {
      console.log(
        JSON.stringify(
          list.map((s) => ({
            sessionId: s.sessionId,
            description: s.originalTask.replace(/\s+/g, " ").trim().slice(0, 160),
            updatedAt: s.updatedAt,
            turnCount: s.turns.length,
          })),
        ),
      );
      return;
    }
    if (!list.length) console.log(`${statusIcon("info")} ${ui.gray("No sessions for this repo.")}`);
    for (const s of list)
      console.log(
        `${statusIcon("info")} ${ui.bold(s.sessionId)} ${ui.gray(s.updatedAt)} ${ui.cyan(`turns=${s.turns.length}`)} ${s.originalTask}`,
      );
    return;
  }
  if (raw[0] === "session") {
    const json = raw.includes("--json");
    if (raw[1] === "clear") {
      clearActiveSession();
      console.log(`${statusIcon("ok")} ${ui.green("Cleared active session for this repo.")}`);
      return;
    }
    if (raw[1] === "new") {
      const task = raw.slice(2).join(" ").trim() || "New session";
      const s = createSession(task);
      console.log(
        `${statusIcon("ok")} ${ui.green("Created and activated session")} ${ui.bold(s.sessionId)}`,
      );
      if (raw.length > 2) {
        const args = parseArgs(raw.slice(2));
        process.exitCode = await execute(args, s, config, path);
      }
      return;
    }
    const requestedId = raw[1] && raw[1] !== "--json" ? raw[1] : undefined;
    const s = requestedId ? loadSession(requestedId) : getActiveSession();
    if (json) {
      console.log(
        JSON.stringify(
          s
            ? requestedId
              ? loadSessionTranscript(s.sessionId)
              : {
                  sessionId: s.sessionId,
                  description: s.originalTask.replace(/\s+/g, " ").trim().slice(0, 160),
                  updatedAt: s.updatedAt,
                  turnCount: s.turns.length,
                }
            : null,
        ),
      );
      return;
    }
    console.log(
      s
        ? `${divider("Active session")}\n${ui.cyan(JSON.stringify(s, null, 2))}`
        : `${statusIcon("info")} ${ui.gray("No active session for this repo.")}`,
    );
    return;
  }

  const args = parseArgs(raw);
  if (!args.task) {
    help();
    process.exitCode = 2;
    return;
  }
  let session: SessionState | undefined;
  if (args.sessionId) {
    session = loadSession(args.sessionId);
    if (!args.dryRun) setActiveSession(process.cwd(), session.sessionId);
  } else if (args.continueMode) {
    session = getActiveSession();
    if (!session) throw new Error('No active session. Start with: airo session new "task"');
  } else if (!args.dryRun) session = createSession(args.task);
  process.exitCode = await execute(args, session, config, path);
}

main().catch((err) => {
  console.error(
    `${statusIcon("error")} ${ui.red(err instanceof Error ? err.message : String(err))}`,
  );
  process.exitCode = 1;
});
