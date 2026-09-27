import { agentColor, command, outputWidth, sectionRule, ui, visibleLength } from "./ui.js";
import { VERSION } from "./version.js";

/** The introduction shown immediately before the interactive first-run setup. */
export function firstRunWelcome(): string {
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
    sectionRule("Automatic discovery"),
    `${ui.gray("AIRO detects installed supported providers and maps their available models onto fast, balanced, and deep tiers.")}`,
    `${ui.gray("Reviewed fallback profiles are used when a provider cannot expose its model catalog.")}`,
    "",
    `${ui.gray("First run only asks for the provider execution permissions that AIRO must not assume.")}`,
    `${ui.gray("Inspect the current mapping with")} ${command("airo models")} ${ui.gray("and revisit permissions with")} ${command("airo setup")}.`,
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
