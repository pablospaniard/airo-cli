import { DEFAULT_CONFIG } from "./config.js";
import { AGENTS } from "./providers.js";
import type { RouterConfig } from "./types.js";
import { agentColor, command, outputWidth, sectionRule, ui, visibleLength } from "./ui.js";
import { VERSION } from "./version.js";

function defaultsTable(config: RouterConfig): string[] {
  const rows = AGENTS.flatMap((agent) =>
    (["fast", "balanced", "deep"] as const).map((tier) => {
      const profile = config[agent].models[tier];
      return [agent, tier, profile.model, profile.effort ?? "auto"];
    }),
  );
  const headers = ["Provider", "Tier", "Model", "Effort"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row: string[], colorProvider = false) =>
    row
      .map((value, index) => {
        const padded = value.padEnd(widths[index]);
        return colorProvider && index === 0
          ? agentColor(value as "claude" | "codex" | "gemini" | "copilot", padded)
          : padded;
      })
      .join("  ");
  return [
    ui.gray(formatRow(headers)),
    ui.gray(widths.map((width) => "─".repeat(width)).join("  ")),
    ...rows.map((row) => formatRow(row, true)),
  ];
}

/** The introduction shown immediately before the interactive first-run setup. */
export function firstRunWelcome(config: RouterConfig = DEFAULT_CONFIG): string {
  const logo = [
    " █████╗ ██╗██████╗   ██████╗ ",
    "██╔══██╗██║██╔══██╗ ██╔═══██╗",
    "███████║██║██████╔╝ ██║   ██║",
    "██╔══██║██║██╔══██╗ ██║   ██║",
    "██║  ██║██║██║  ██║ ╚██████╔╝",
    "╚═╝  ╚═╝╚═╝╚═╝  ╚═╝  ╚═════╝ ",
  ].map((line) => ui.bold(ui.cyan(line)));

  const width = outputWidth();
  const lines = [
    "",
    ...logo,
    ui.dim("Adaptive Intelligence Routing & Orchestration"),
    ui.gray(`Version ${VERSION}`),
    "",
    sectionRule("Welcome"),
    `${ui.bold("AIRO")} routes each coding task between ${agentColor("claude", "Claude Code")}, ${agentColor("codex", "Codex CLI")}, ${agentColor("gemini", "Gemini CLI")}, and ${agentColor("copilot", "GitHub Copilot CLI")}, choosing a model tier for the work.`,
    ui.gray("It uses your existing provider CLI logins; AIRO does not require another API key."),
    "",
    sectionRule("Initial defaults"),
    ...defaultsTable(config),
    "",
    `${ui.gray("Tie-break provider:")} ${agentColor(config.defaultAgent, config.defaultAgent)}`,
    `${ui.gray("Choose models for these tiers, or press")} ${ui.bold("Enter")} ${ui.gray("to keep the displayed defaults.")}`,
    `${ui.gray("Your settings will be saved to")} ${ui.cyan("~/.config/airo/config.json")}.`,
    `${ui.gray("You can revisit them with")} ${command("airo setup")} ${ui.gray("and inspect them with")} ${command("airo models")}.`,
    "",
  ].join("\n");

  return lines
    .split("\n")
    .map((line) => {
      if (!line) return line;
      return `${" ".repeat(Math.max(0, Math.floor((width - visibleLength(line)) / 2)))}${line}`;
    })
    .join("\n");
}
