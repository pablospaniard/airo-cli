import { spawn, spawnSync } from "node:child_process";
import type {
  Agent,
  AgentRunResult,
  ProviderFailure,
  RouteResult,
  RouterConfig,
  TokenUsage,
} from "./types.js";
import type { PhaseLogMeta, RunLogger } from "./logging.js";

export function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

/** Provider errors that usually mean this account/model cannot serve the request right now. */
export function isUsageLimitError(text: string, exitCode?: number): boolean {
  if (!text || exitCode === 0) return false;
  return /(?:usage|quota|rate|session|request|message|token)[ -]?(?:limit|limited|exhausted|exceeded)|(?:hit|reached|exceeded|ran out of).{0,40}(?:limit|quota|credits?|balance)|(?:credit|credits|balance)[ -]?(?:limit|exhausted|insufficient)|too many requests|(?:429|resource_exhausted|rate_limit_error|quota_exceeded)|billing.{0,30}(?:limit|disabled|past due)|out of credits/i.test(
    text,
  );
}

/**
 * Provider sign-in failures. A provider CLI can be installed and still be
 * unusable because its account is missing or expired: Codex reports that as
 * repeated `401 Unauthorized` reconnect attempts and a failed turn. Requires a
 * non-zero exit so a 401 the agent merely encountered while working on the
 * task is not mistaken for the provider's own credentials.
 */
export function isProviderAuthError(text: string, exitCode?: number): boolean {
  if (!text || exitCode === 0) return false;
  return /(?:40[13]\s+(?:unauthorized|forbidden)|unauthorized|missing bearer|invalid[ _-]?api[ _-]?key|authentication (?:failed|required|error)|(?:auth|access|oauth|refresh|session) token (?:is )?(?:missing|invalid|expired)|credentials? (?:are |is )?(?:missing|invalid|expired|not found)|not (?:signed|logged) in|please (?:sign|log) in|run\s+`?(?:\/?login|\w+ login)`?)/i.test(
    text,
  );
}

/** Failures that mean this provider cannot serve the run, so another one should take over. */
export function isProviderUnavailableError(text: string, exitCode?: number): boolean {
  return isUsageLimitError(text, exitCode) || isProviderAuthError(text, exitCode);
}

export function commandVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error) return `ERROR: ${result.error.message}`;
  return (result.stdout || result.stderr || "").trim() || `exit ${result.status}`;
}

export interface ProviderInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Index of the task prompt in args, so diagnostics can redact it. */
  promptArgIndex: number;
}

export interface ProviderRuntimeAdapter {
  buildInvocation: (
    route: RouteResult,
    prompt: string,
    config: RouterConfig,
    headless: boolean,
    structuredProgress: boolean,
    elevated?: boolean,
  ) => ProviderInvocation;
  parseProgress: (event: unknown) => ParsedProviderEvent;
  /** Classify failures that allow an automatic route to try another provider. */
  classifyFailure: (text: string, exitCode?: number) => ProviderFailure | undefined;
}

function classifyCommonProviderFailure(
  text: string,
  exitCode?: number,
): ProviderFailure | undefined {
  if (isProviderAuthError(text, exitCode)) return "authentication";
  if (isUsageLimitError(text, exitCode)) return "usage limit";
  return undefined;
}

function claudeInvocation(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  headless: boolean,
  structuredProgress: boolean,
  elevated = false,
): ProviderInvocation {
  const provider = config.claude;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const args = [...(provider.args ?? [])];
  if (headless) args.push("-p");
  args.push("--model", route.model);
  if (structuredProgress && headless) args.push("--output-format", "stream-json", "--verbose");
  const effectivePermissionMode =
    elevated || config.permissions.mode === "fullAccess"
      ? "bypassPermissions"
      : provider.permissionMode;
  if (headless && effectivePermissionMode) args.push("--permission-mode", effectivePermissionMode);
  if (route.effort !== "auto") env.CLAUDE_CODE_EFFORT_LEVEL = route.effort;
  const promptArgIndex = args.push(prompt) - 1;
  return { args, env, promptArgIndex };
}

function codexInvocation(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  headless: boolean,
  structuredProgress: boolean,
  elevated = false,
): ProviderInvocation {
  const provider = config.codex;
  const args = [...(provider.args ?? [])];
  if (elevated || config.permissions.mode === "fullAccess") {
    args.push("--sandbox", "danger-full-access");
  } else {
    args.push("--sandbox", "workspace-write");
    if (config.permissions.networkAccess)
      args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  // AIRO owns the approval UI and retries an approved action with an elevated
  // sandbox. The headless child has no interactive stdin for nested prompts.
  args.push("--ask-for-approval", "never");
  if (headless) args.push("exec");
  if (structuredProgress && headless) args.push("--json");
  args.push("--model", route.model);
  if (route.effort !== "auto") args.push("-c", `model_reasoning_effort="${route.effort}"`);
  const promptArgIndex = args.push(prompt) - 1;
  return { args, env: { ...process.env }, promptArgIndex };
}

function geminiInvocation(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  headless: boolean,
  structuredProgress: boolean,
  elevated = false,
): ProviderInvocation {
  const provider = config.gemini;
  const args = [...(provider.args ?? [])];
  const promptArgIndex = headless ? args.push("--prompt", prompt) - 1 : -1;
  args.push("--model", route.model);
  args.push(
    "--approval-mode",
    elevated || config.permissions.mode === "fullAccess" ? "yolo" : "default",
  );
  if (elevated || config.permissions.mode === "fullAccess") args.push("--skip-trust");
  if (structuredProgress && headless) args.push("--output-format", "stream-json");
  return { args, env: { ...process.env }, promptArgIndex };
}

function copilotInvocation(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  headless: boolean,
  structuredProgress: boolean,
  elevated = false,
): ProviderInvocation {
  const provider = config.copilot;
  const args = [...(provider.args ?? [])];
  const promptArgIndex = headless ? args.push("--prompt", prompt) - 1 : -1;
  args.push("--model", route.model);
  if (elevated || config.permissions.mode === "fullAccess") args.push("--allow-all");
  else if (config.permissions.networkAccess) args.push("--allow-all-urls");
  if (structuredProgress && headless) args.push("--silent");
  const interactivePromptIndex = !headless ? args.push(prompt) - 1 : promptArgIndex;
  return { args, env: { ...process.env }, promptArgIndex: interactivePromptIndex };
}

function compactJson(value: unknown, max = 140): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export interface ParsedProviderEvent {
  messages: Array<{ category: string; text: string }>;
  candidateOutput?: string;
  appendCandidate?: boolean;
  finalOutput?: string;
  usage?: TokenUsage;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function addTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

export function claudeProgress(event: any): ParsedProviderEvent {
  const messages: Array<{ category: string; text: string }> = [];
  const candidate: string[] = [];
  if (!event || typeof event !== "object") return { messages };

  if (event.type === "system") {
    if (event.subtype === "init")
      messages.push({
        category: "system",
        text: `initialized${event.model ? ` model=${event.model}` : ""}${event.session_id ? ` session=${event.session_id}` : ""}`,
      });
    else if (event.subtype === "api_retry")
      messages.push({
        category: "retry",
        text: `API retry ${event.attempt ?? "?"}/${event.max_retries ?? "?"} in ${event.retry_delay_ms ?? "?"}ms (${event.error ?? "unknown"})`,
      });
    else if (event.subtype === "plugin_install")
      messages.push({
        category: "system",
        text: `plugin install ${event.status ?? "update"}${event.name ? `: ${event.name}` : ""}`,
      });
  }

  if (
    event.type === "assistant" &&
    event.message?.content &&
    Array.isArray(event.message.content)
  ) {
    for (const block of event.message.content) {
      if (block?.type === "text" && block.text) {
        messages.push({ category: "message", text: String(block.text) });
        candidate.push(String(block.text));
      } else if (block?.type === "tool_use") {
        const name = block.name ?? "tool";
        const details = block.input ? ` ${compactJson(block.input)}` : "";
        messages.push({ category: "tool", text: `${name}${details}` });
      }
    }
  }

  // Some versions emit top-level tool progress fields.
  if (event.type === "tool_use" || event.type === "tool") {
    messages.push({
      category: "tool",
      text: `${event.name ?? event.tool_name ?? "tool"}${event.input ? ` ${compactJson(event.input)}` : ""}`,
    });
  }

  if (event.type === "result") {
    const bits = [event.subtype ?? "completed"];
    if (event.duration_ms != null) bits.push(`${Math.round(event.duration_ms / 1000)}s`);
    messages.push({ category: "result", text: bits.join(" ") });
  }

  // Intentionally do not surface raw thinking/reasoning content.
  const rawUsage = event.type === "result" ? event.usage : undefined;
  const usage = rawUsage
    ? {
        uncachedInputTokens: number(rawUsage.input_tokens),
        cachedInputTokens: number(rawUsage.cache_read_input_tokens),
        cacheWriteInputTokens: number(rawUsage.cache_creation_input_tokens),
        outputTokens: number(rawUsage.output_tokens),
        reasoningOutputTokens: 0,
      }
    : undefined;
  return {
    messages,
    candidateOutput: candidate.length ? candidate.join("\n") : undefined,
    finalOutput: event.type === "result" && event.result ? String(event.result) : undefined,
    usage,
  };
}

export function codexProgress(event: any): ParsedProviderEvent {
  const messages: Array<{ category: string; text: string }> = [];
  let candidateOutput: string | undefined;
  let usage: TokenUsage | undefined;
  if (!event || typeof event !== "object") return { messages };

  if (event.type === "thread.started")
    messages.push({
      category: "system",
      text: `thread started${event.thread_id ? ` ${event.thread_id}` : ""}`,
    });
  else if (event.type === "turn.started")
    messages.push({ category: "system", text: "turn started" });
  else if (event.type === "turn.failed")
    messages.push({
      category: "error",
      text: `turn failed${event.error?.message ? `: ${event.error.message}` : ""}`,
    });
  else if (event.type === "error")
    messages.push({ category: "error", text: event.message ?? compactJson(event) });
  else if (event.type === "turn.completed") {
    const u = event.usage;
    messages.push({
      category: "result",
      text: u
        ? `turn completed tokens in=${u.input_tokens ?? "?"} cached=${u.cached_input_tokens ?? "?"} out=${u.output_tokens ?? "?"}`
        : "turn completed",
    });
    if (u) {
      const input = number(u.input_tokens);
      const cached = number(u.cached_input_tokens);
      usage = {
        uncachedInputTokens: Math.max(0, input - cached),
        cachedInputTokens: cached,
        cacheWriteInputTokens: number(u.cache_write_input_tokens),
        outputTokens: number(u.output_tokens),
        reasoningOutputTokens: number(u.reasoning_output_tokens),
      };
    }
  }

  if ((event.type === "item.started" || event.type === "item.completed") && event.item) {
    const item = event.item;
    const done = event.type === "item.completed";
    switch (item.type) {
      case "command_execution":
        messages.push({
          category: "tool",
          text: done
            ? `command completed${item.exit_code != null ? ` (exit ${item.exit_code})` : ""}`
            : `command: ${String(item.command ?? "").slice(0, 140)}`,
        });
        break;
      case "file_change":
      case "file_changes":
        messages.push({
          category: "file",
          text: `${done ? "file change completed" : "file change"}${item.path ? `: ${item.path}` : item.changes ? `: ${compactJson(item.changes)}` : ""}`,
        });
        break;
      case "mcp_tool_call":
        messages.push({
          category: "tool",
          text: `MCP ${item.server ?? ""}${(item.tool ?? item.name) ? `/${item.tool ?? item.name}` : ""}${done ? " completed" : ""}`,
        });
        break;
      case "web_search":
        messages.push({
          category: "tool",
          text: `web search${item.query ? `: ${item.query}` : ""}${done ? " completed" : ""}`,
        });
        break;
      case "agent_message":
        if (item.text) {
          messages.push({ category: "message", text: String(item.text) });
          if (done) candidateOutput = String(item.text);
        }
        break;
      case "reasoning":
        // Do not expose chain-of-thought. A status marker is enough for progress visibility.
        if (!done) messages.push({ category: "status", text: "reasoning…" });
        break;
      default:
        if (!done) messages.push({ category: "status", text: `${item.type ?? "item"} started` });
        break;
    }
  }
  return { messages, candidateOutput, usage };
}

export function extractQuestion(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*AIROUTE_QUESTION:\s*(.+?)(?:\n|$)/is);
  const question = match?.[1]?.trim();
  if (question && !/[<>]/.test(question)) return question;

  // Providers occasionally ignore the marker after a tool is denied and turn the
  // denial into a natural-language blocking question. Only recognize a narrow
  // fallback here so optional closing offers do not unexpectedly resume a run.
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last || !/\?\s*$/.test(last)) return undefined;
  const blockingSignal =
    /\b(?:approval|permission|authori[sz]ation|your (?:input|decision|confirmation)|need you to|cannot (?:continue|proceed)|can't (?:continue|proceed)|blocked)\b/i;
  return blockingSignal.test(last) ? last : undefined;
}

/**
 * Turn provider-reported sandbox and access failures into an approval prompt.
 *
 * Providers do not always follow the AIROUTE_QUESTION protocol after a denied
 * tool call. Keep this deliberately limited to concrete failure language so a
 * general discussion about permissions does not pause the run.
 */
export function permissionFailureQuestion(text: string): string | undefined {
  const failure =
    /\b(?:permission denied|operation not permitted|access denied|approval (?:is )?required|requires? (?:user )?approval|blocked by (?:the )?sandbox|sandbox (?:denied|blocked|restriction)|(?:network|internet|github(?: api)?|api) access (?:is )?(?:disabled|denied|blocked|restricted|unavailable))\b/i;
  const connectionFailure =
    /\b(?:could(?:n't| not)|cannot|can't|unable to|failed to)\b.{0,160}\b(?:access|connect|fetch|reach|retrieve)\b.{0,160}\b(?:connection error|failed to connect|network is unreachable|could not resolve host|name resolution)\b/i;
  const reversedConnectionFailure =
    /\b(?:connection error|failed to connect|network is unreachable|could not resolve host|name resolution)\b.{0,160}\b(?:could(?:n't| not)|cannot|can't|unable to|failed)\b/i;
  const githubConnectionFailure =
    /\b(?:cannot|can't|unable to|failed to)\s+connect\s+to\s+(?:api\.)?github\.com\b/i;
  // On macOS, a workspace-write Codex sandbox may be unable to read the
  // credential stored in Keychain. `gh auth status` reports that as an invalid
  // token even though the same credential works outside the sandbox. Treat the
  // first occurrence as an access failure so AIRO can offer a one-run elevated
  // retry instead of repeatedly asking the user to sign in again.
  const githubCredentialFailure =
    /\b(?:(?:github|gh)(?:\s+cli)?\s+(?:authentication|auth|token)|(?:configured|active)\s+(?:github\s+)?token)\b.{0,120}\b(?:invalid|expired|unavailable|unreadable|failed)\b/i;
  const directPermissionRequest =
    /\b(?:command|operation|tool|sandbox|access)\b.{0,120}\b(?:needs?|requires?|requests?)\b.{0,40}\b(?:your\s+)?(?:approval|permission|authori[sz]ation)\b/i;

  if (
    !failure.test(text) &&
    !connectionFailure.test(text) &&
    !reversedConnectionFailure.test(text) &&
    !githubConnectionFailure.test(text) &&
    !githubCredentialFailure.test(text) &&
    !directPermissionRequest.test(text)
  )
    return undefined;

  const action = /\b(?:github|gh\s+(?:api|pr|issue|repo|run))\b/i.test(text)
    ? "access GitHub and retry the blocked action"
    : /\b(?:network|connection|connect|resolve host|name resolution)\b/i.test(text)
      ? "retry the blocked network action"
      : "retry the blocked action with elevated access";
  return `Permission required to ${action}. Approve?`;
}

export function isApprovalAnswer(answer: string): boolean {
  return /^(?:y|yes|approve|approved|allow|allowed|confirm|confirmed|proceed)$/i.test(
    answer.trim(),
  );
}

/** Only permission prompts may turn a natural affirmative into an elevated retry. */
export function isPermissionApproval(question: string, answer: string): boolean {
  return isApprovalAnswer(answer) && /^Permission required to\b/i.test(question.trim());
}

export function genericProgress(event: any): ParsedProviderEvent {
  const messages: Array<{ category: string; text: string }> = [];
  if (typeof event === "string") return { messages, finalOutput: event };
  if (!event || typeof event !== "object") return { messages };
  const text =
    event.response ?? event.output ?? event.message?.content ?? event.message ?? event.text;
  if (text) messages.push({ category: "message", text: String(text) });
  if (event.error)
    messages.push({ category: "error", text: String(event.error?.message ?? event.error) });
  const usage = event.usage;
  return {
    messages,
    candidateOutput: text ? String(text) : undefined,
    finalOutput: text ? String(text) : undefined,
    usage: usage
      ? {
          uncachedInputTokens: number(usage.input_tokens ?? usage.promptTokenCount),
          cachedInputTokens: number(usage.cached_input_tokens ?? usage.cachedContentTokenCount),
          cacheWriteInputTokens: 0,
          outputTokens: number(usage.output_tokens ?? usage.candidatesTokenCount),
          reasoningOutputTokens: 0,
        }
      : undefined,
  };
}

export function geminiProgress(event: any): ParsedProviderEvent {
  const messages: Array<{ category: string; text: string }> = [];
  if (!event || typeof event !== "object") return { messages };

  if (event.type === "init")
    messages.push({
      category: "system",
      text: `initialized${event.model ? ` model=${event.model}` : ""}${event.session_id ? ` session=${event.session_id}` : ""}`,
    });

  const content =
    event.type === "message" && event.role === "assistant" && typeof event.content === "string"
      ? event.content
      : undefined;
  if (content) messages.push({ category: "message", text: content });

  if (event.type === "tool_use")
    messages.push({
      category: "tool",
      text: `${event.tool_name ?? "tool"}${event.parameters ? ` ${compactJson(event.parameters)}` : ""}`,
    });
  else if (event.type === "tool_result")
    messages.push({
      category: event.status === "error" ? "error" : "tool",
      text:
        event.error?.message ??
        `${event.tool_id ?? "tool"} ${event.status ?? "completed"}${event.output ? `: ${event.output}` : ""}`,
    });
  else if (event.type === "error")
    messages.push({
      category: event.severity === "warning" ? "warning" : "error",
      text: String(event.message ?? event.error?.message ?? compactJson(event)),
    });
  else if (event.type === "result")
    messages.push({ category: "result", text: String(event.status ?? "completed") });

  const stats = event.type === "result" ? event.stats : undefined;
  const usage = stats
    ? {
        uncachedInputTokens: number(
          stats.input ?? Math.max(0, number(stats.input_tokens) - number(stats.cached)),
        ),
        cachedInputTokens: number(stats.cached),
        cacheWriteInputTokens: 0,
        outputTokens: number(stats.output_tokens),
        reasoningOutputTokens: 0,
      }
    : undefined;
  return {
    messages,
    candidateOutput: content,
    appendCandidate: Boolean(content && event.delta),
    usage,
  };
}

export const PROVIDER_RUNTIME_ADAPTERS = {
  claude: {
    buildInvocation: claudeInvocation,
    parseProgress: claudeProgress,
    classifyFailure: classifyCommonProviderFailure,
  },
  codex: {
    buildInvocation: codexInvocation,
    parseProgress: codexProgress,
    classifyFailure: classifyCommonProviderFailure,
  },
  gemini: {
    buildInvocation: geminiInvocation,
    parseProgress: geminiProgress,
    classifyFailure: classifyCommonProviderFailure,
  },
  copilot: {
    buildInvocation: copilotInvocation,
    parseProgress: genericProgress,
    classifyFailure: classifyCommonProviderFailure,
  },
} satisfies Record<Agent, ProviderRuntimeAdapter>;

export function providerRuntimeAdapter(agent: Agent): ProviderRuntimeAdapter {
  return PROVIDER_RUNTIME_ADAPTERS[agent];
}

export function classifyProviderFailure(
  agent: Agent,
  text: string,
  exitCode?: number,
): ProviderFailure | undefined {
  return providerRuntimeAdapter(agent).classifyFailure(text, exitCode);
}

export function buildProviderInvocation(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  options: { headless: boolean; structuredProgress: boolean; elevated?: boolean },
): ProviderInvocation {
  return providerRuntimeAdapter(route.agent).buildInvocation(
    route,
    prompt,
    config,
    options.headless,
    options.structuredProgress,
    options.elevated,
  );
}

export function diagnosticInvocationArgs(invocation: ProviderInvocation): string[] {
  return invocation.args.map((arg, index) =>
    index === invocation.promptArgIndex ? `<prompt:${arg.length} chars>` : arg,
  );
}

export function progressFor(agent: Agent, event: any): ParsedProviderEvent {
  return providerRuntimeAdapter(agent).parseProgress(event);
}

export async function runAgent(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  options: {
    headless?: boolean;
    capture?: boolean;
    logger?: RunLogger;
    logMeta?: PhaseLogMeta;
    elevated?: boolean;
  } = {},
): Promise<AgentRunResult> {
  const provider = config[route.agent];
  const headless = options.headless ?? false;
  const capture = options.capture ?? false;
  const structuredProgress = Boolean(options.logger && headless);
  const invocation = buildProviderInvocation(route, prompt, config, {
    headless,
    structuredProgress,
    elevated: options.elevated,
  });
  const { args, env } = invocation;
  const diagnosticArgs = diagnosticInvocationArgs(invocation);

  options.logger?.metadata(
    `command=${provider.command} args=${JSON.stringify(diagnosticArgs)} promptChars=${prompt.length}`,
  );

  if (!capture && !options.logger) {
    const child = spawn(provider.command, args, { cwd: process.cwd(), stdio: "inherit", env });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code: number | null, signal: string | null) =>
        resolve(signal ? 128 : (code ?? 1)),
      );
    });
    return { exitCode, output: "" };
  }

  const child = spawn(provider.command, args, {
    cwd: process.cwd(),
    // Headless providers receive the complete prompt as an argument. Leaving
    // stdin open makes Codex wait for "additional input" forever when AIRO is
    // launched by an editor or another process with piped stdin.
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let fallbackOutput = "";
  let candidateOutput = "";
  let finalOutput = "";
  let stdoutBuffer = "";
  let stderrOutput = "";
  let question: string | undefined;
  let usage: TokenUsage | undefined;

  const handleStructuredLine = (line: string) => {
    if (!line.trim()) return;
    options.logger?.rawEvent(options.logMeta!, line);
    try {
      const event = JSON.parse(line);
      const progress = progressFor(route.agent, event);
      for (const msg of progress.messages) {
        options.logger?.progress(options.logMeta!, msg.text, msg.category);
        // Structured providers may report failures only as progress events. Keep
        // error text in the captured result so callers can decide whether to
        // retry on another provider.
        if (msg.category === "error") fallbackOutput += `${msg.text}\n`;
        if (!question && msg.category === "message") question = extractQuestion(msg.text);
      }
      if (progress.candidateOutput)
        candidateOutput = progress.appendCandidate
          ? candidateOutput + progress.candidateOutput
          : progress.candidateOutput;
      if (progress.finalOutput) finalOutput = progress.finalOutput;
      usage = addTokenUsage(usage, progress.usage);
      const semanticOutput = progress.finalOutput ?? progress.candidateOutput;
      if (!question && semanticOutput) question = extractQuestion(semanticOutput);
    } catch {
      // Forward non-JSON provider output instead of losing it.
      options.logger?.progress(options.logMeta!, line, "output");
      fallbackOutput += `${line}\n`;
    }
  };

  child.stdout?.on("data", (chunk: any) => {
    const s = String(chunk);
    if (structuredProgress) {
      stdoutBuffer += s;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleStructuredLine(line);
    } else {
      fallbackOutput += s;
      process.stdout.write(s);
    }
  });

  child.stderr?.on("data", (chunk: any) => {
    const s = String(chunk);
    stderrOutput += s;
    if (options.logger && options.logMeta) options.logger.stderr(options.logMeta, s);
    else process.stderr.write(s);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: string | null) =>
      resolve(signal ? 128 : (code ?? 1)),
    );
  });

  if (structuredProgress && stdoutBuffer.trim()) handleStructuredLine(stdoutBuffer);
  const output =
    `${(finalOutput || candidateOutput || fallbackOutput).trim()}${exitCode !== 0 && stderrOutput.trim() ? `\n${stderrOutput.trim()}` : ""}`.trim();
  if (!question) question = extractQuestion(output);
  if (config.permissions.mode === "prompt" && !options.elevated) {
    // Prefer the normalized permission prompt even when the provider phrased
    // the denial as a question. Clients can then render Approve/Decline rather
    // than a generic Reply action, and approval triggers the elevated retry.
    question = permissionFailureQuestion(output) ?? question;
  }
  return { exitCode, output, question, usage };
}
