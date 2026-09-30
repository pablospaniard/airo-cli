import type { Agent, FeedbackRating, LogLevel, ModelTier } from "./types.js";
import type { UsagePeriod } from "./usage.js";

export type InteractiveMode = "auto" | "adaptive" | "single";

export interface InteractivePreferences {
  mode: InteractiveMode;
  agent: "auto" | Agent;
  tier?: ModelTier;
  logLevel: LogLevel;
}

export type InteractiveAction =
  | { kind: "empty" }
  | { kind: "task"; task: string; noJev?: boolean }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "new"; title?: string }
  | { kind: "status" }
  | { kind: "sessions" }
  | { kind: "models" }
  | { kind: "account" }
  | { kind: "usage"; limit?: number; costPeriod?: UsagePeriod }
  | { kind: "logs" }
  | { kind: "attach"; path: string }
  | { kind: "feedback"; rating: FeedbackRating; note?: string; phaseId?: string }
  | {
      kind: "learning";
      action: "status" | "explain" | "reset";
      targetId?: string;
      confirmed?: boolean;
    }
  | { kind: "clear" }
  | { kind: "set-mode"; value: InteractiveMode }
  | { kind: "set-agent"; value: "auto" | Agent }
  | { kind: "set-tier"; value?: ModelTier }
  | { kind: "set-log"; value: LogLevel }
  | { kind: "error"; message: string };

export interface InteractiveCommandInfo {
  /** The bare word readline should insert when this command is selected. */
  command: string;
  /** Usage shown in the picker; `<required>` and `[optional]` args are highlighted. */
  usage: string;
  description: string;
}

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandInfo[] = [
  { command: "/help", usage: "/help, /?", description: "show this reference" },
  { command: "/status", usage: "/status", description: "show session and run preferences" },
  { command: "/new", usage: "/new [title]", description: "start a fresh session" },
  { command: "/sessions", usage: "/sessions", description: "list repository sessions" },
  { command: "/models", usage: "/models", description: "show active model mapping" },
  { command: "/account", usage: "/account", description: "show provider accounts" },
  {
    command: "/usage",
    usage: "/usage [limit] | /usage cost [period]",
    description: "show token usage, or an API-price cost estimate",
  },
  { command: "/logs", usage: "/logs", description: "show recent run logs" },
  {
    command: "/attach",
    usage: "/attach <file-path>",
    description: "attach a local image, PDF, Markdown, or JSON file to the next task",
  },
  {
    command: "/no-jev",
    usage: "/no-jev <task>",
    description: "run one task without sending it to Jev",
  },
  {
    command: "/feedback",
    usage: "/feedback good|bad [note] | /feedback phase <id> good|bad [note]",
    description: "rate the latest run or one phase",
  },
  {
    command: "/learning",
    usage: "/learning status|explain <id>|reset --yes",
    description: "inspect or reset learning",
  },
  { command: "/mode", usage: "/mode auto|adaptive|single", description: "set workflow mode" },
  {
    command: "/agent",
    usage: "/agent auto|claude|codex|gemini|copilot",
    description: "select provider",
  },
  {
    command: "/tier",
    usage: "/tier auto|fast|balanced|deep",
    description: "set model tier",
  },
  { command: "/log", usage: "/log compact|live|verbose", description: "set output detail" },
  { command: "/clear", usage: "/clear", description: "clear the screen" },
  { command: "/exit", usage: "/exit, /quit", description: "exit interactive mode" },
];

/** Commands intentionally kept outside the live readline session. */
export const INTERACTIVE_SHELL_HELP = [
  ["airo setup", "review provider permissions"],
  ["airo doctor", "check providers and paths"],
  ["airo history export|import …", "move encrypted learning"],
  ["airo repository id|link …", "manage learning scope"],
  ["airo feedback jev status|enable|disable", "manage local Jev feedback"],
  ["airo feedback jev inspect|reset", "inspect or clear Jev evidence"],
  ["airo sync login|enable|now|status", "manage encrypted sync"],
  ["airo sync devices|export|logout", "manage sync data and devices"],
  ["airo sync delete-cloud-data --yes", "delete cloud data"],
] as const;

/** Full command info for each match, in picker order, for rendering usage + description. */
export function interactiveCommandSuggestions(input: string): readonly InteractiveCommandInfo[] {
  if (!input.startsWith("/")) return [];
  const matches = INTERACTIVE_COMMANDS.filter((entry) =>
    entry.command.startsWith(input.toLowerCase()),
  );
  return matches.length ? matches : INTERACTIVE_COMMANDS;
}

/** Bare command words for readline's tab completer. */
export function interactiveCommandMatches(input: string): readonly string[] {
  return interactiveCommandSuggestions(input).map((entry) => entry.command);
}

/** Normalize the path most terminals insert when a file is dragged into readline. */
export function cleanDroppedPath(input: string): string {
  const value = input.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  }
  return value;
}

export function isSupportedAttachmentPath(input: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|pdf|md|markdown|json)$/i.test(cleanDroppedPath(input));
}

export function parseInteractiveInput(input: string): InteractiveAction {
  const value = input.trim();
  if (!value) return { kind: "empty" };
  if (value === "--no-jev")
    return { kind: "error", message: "Usage: --no-jev <task> or /no-jev <task>" };
  if (value.startsWith("--no-jev "))
    return { kind: "task", task: value.slice("--no-jev ".length).trim(), noJev: true };
  if (!value.startsWith("/")) return { kind: "task", task: value };

  const [rawCommand, ...args] = value.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const first = args[0]?.toLowerCase();

  if (command === "/exit" || command === "/quit") return { kind: "quit" };
  if (command === "/help" || command === "/?") return { kind: "help" };
  if (command === "/status") return { kind: "status" };
  if (command === "/sessions") return { kind: "sessions" };
  if (command === "/models") return { kind: "models" };
  if (command === "/account") return { kind: "account" };
  if (command === "/usage") {
    if (first === "cost") {
      const period = args[1] ?? "lifetime";
      if (!["daily", "weekly", "monthly", "lifetime"].includes(period) || args[2])
        return { kind: "error", message: "Usage: /usage cost [daily|weekly|monthly|lifetime]" };
      return { kind: "usage", costPeriod: period as UsagePeriod };
    }
    const limit = args[0] === undefined ? undefined : Number(args[0]);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
      return {
        kind: "error",
        message: "Usage: /usage [limit] | /usage cost [daily|weekly|monthly|lifetime]",
      };
    return { kind: "usage", limit };
  }
  if (command === "/logs") return { kind: "logs" };
  if (command === "/no-jev") {
    const task = args.join(" ").trim();
    return task
      ? { kind: "task", task, noJev: true }
      : { kind: "error", message: "Usage: /no-jev <task>" };
  }
  if (command === "/attach") {
    const path = args.join(" ").trim();
    return path
      ? { kind: "attach", path }
      : { kind: "error", message: "Usage: /attach <file-path>" };
  }
  if (command === "/feedback") {
    if (first === "phase") {
      const phaseId = args[1];
      const rating = args[2]?.toLowerCase();
      if (!phaseId || (rating !== "good" && rating !== "bad"))
        return { kind: "error", message: "Usage: /feedback phase <id> good|bad [note]" };
      return {
        kind: "feedback",
        phaseId,
        rating,
        note: args.slice(3).join(" ") || undefined,
      };
    }
    if (first !== "good" && first !== "bad")
      return {
        kind: "error",
        message: "Usage: /feedback good|bad [note] | /feedback phase <id> good|bad [note]",
      };
    return { kind: "feedback", rating: first, note: args.slice(1).join(" ") || undefined };
  }
  if (command === "/learning") {
    if (!first || first === "status") return { kind: "learning", action: "status" };
    if (first === "explain" && args[1])
      return { kind: "learning", action: "explain", targetId: args[1] };
    if (first === "reset")
      return { kind: "learning", action: "reset", confirmed: args.includes("--yes") };
    return {
      kind: "error",
      message: "Usage: /learning status|explain <run-or-phase-id>|reset --yes",
    };
  }
  if (command === "/clear") return { kind: "clear" };
  if (command === "/new") return { kind: "new", title: args.join(" ").trim() || undefined };

  if (command === "/mode") {
    if (first === "auto" || first === "adaptive" || first === "single")
      return { kind: "set-mode", value: first };
    return { kind: "error", message: "Usage: /mode auto|adaptive|single" };
  }
  if (command === "/agent") {
    if (
      first === "auto" ||
      first === "claude" ||
      first === "codex" ||
      first === "gemini" ||
      first === "copilot"
    )
      return { kind: "set-agent", value: first };
    return { kind: "error", message: "Usage: /agent auto|claude|codex|gemini|copilot" };
  }
  if (command === "/tier") {
    if (first === "auto") return { kind: "set-tier", value: undefined };
    if (first === "fast" || first === "balanced" || first === "deep")
      return { kind: "set-tier", value: first };
    return { kind: "error", message: "Usage: /tier auto|fast|balanced|deep" };
  }
  if (command === "/log") {
    if (first === "compact" || first === "live" || first === "verbose")
      return { kind: "set-log", value: first };
    return { kind: "error", message: "Usage: /log compact|live|verbose" };
  }
  return { kind: "error", message: `Unknown command: ${rawCommand}. Use /help to list commands.` };
}

export function taskArgs(
  task: string,
  preferences: InteractivePreferences,
  options: { noJev?: boolean } = {},
): string[] {
  const args = ["--continue"];
  if (options.noJev) args.push("--no-jev");
  if (preferences.mode === "adaptive") args.push("--adaptive");
  if (preferences.mode === "single") args.push("--single");
  if (preferences.agent !== "auto") args.push("--prefer-agent", preferences.agent);
  if (preferences.tier) args.push("--prefer-tier", preferences.tier);
  args.push("--log", preferences.logLevel, task);
  return args;
}

export function parseFeedbackAnswer(input: string): FeedbackRating | undefined {
  const answer = input.trim().toLowerCase();
  if (answer === "y" || answer === "yes") return "good";
  if (answer === "n" || answer === "no") return "bad";
  return undefined;
}
