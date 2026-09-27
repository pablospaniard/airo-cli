import { agentColor, command, outputWidth, sectionRule, ui, visibleLength } from "./ui.js";
import { VERSION } from "./version.js";

/** The introduction shown immediately before the interactive first-run setup. */
export function firstRunWelcome(width = outputWidth()): string {
  const logo = [
    " █████╗ ██╗██████╗   ██████╗ ",
    "██╔══██╗██║██╔══██╗ ██╔═══██╗",
    "███████║██║██████╔╝ ██║   ██║",
    "██╔══██║██║██╔══██╗ ██║   ██║",
    "██║  ██║██║██║  ██║ ╚██████╔╝",
    "╚═╝  ╚═╝╚═╝╚═╝  ╚═╝  ╚═════╝ ",
  ].map((line) => ui.bold(ui.cyan(line)));

  const contentWidth = Math.max(20, Math.min(84, width - 4));
  const centered = (line: string) =>
    line
      ? `${" ".repeat(Math.max(0, Math.floor((width - visibleLength(line)) / 2)))}${line}`
      : line;
  const paragraph = (value: string) => {
    const words = value.trim().split(/\s+/).filter(Boolean);
    const wrapped: string[] = [];
    let line = "";

    for (const word of words) {
      if (line && visibleLength(line) + 1 + visibleLength(word) > contentWidth) {
        wrapped.push(line);
        line = word;
      } else {
        line += `${line ? " " : ""}${word}`;
      }
    }
    if (line) wrapped.push(line);
    return wrapped;
  };

  const lines = [
    "",
    ...logo,
    ui.dim("Adaptive Intelligence Routing & Orchestration"),
    ui.gray(`Version ${VERSION}`),
    "",
    sectionRule("Welcome", Math.min(68, contentWidth)),
    ...paragraph(
      `${ui.bold("AIRO")} routes each coding task between ${agentColor("claude", "Claude Code")}, ${agentColor("codex", "Codex CLI")}, ${agentColor("gemini", "Gemini CLI")}, and ${agentColor("copilot", "GitHub Copilot CLI")}, choosing a model tier for the work.`,
    ),
    ...paragraph(
      ui.gray("It uses your existing provider CLI logins; AIRO does not require another API key."),
    ),
    "",
    sectionRule("Automatic discovery", Math.min(68, contentWidth)),
    ...paragraph(
      ui.gray(
        "AIRO detects installed supported providers and maps their available models onto fast, balanced, and deep tiers.",
      ),
    ),
    ...paragraph(
      ui.gray(
        "Reviewed fallback profiles are used when a provider cannot expose its model catalog.",
      ),
    ),
    "",
    ...paragraph(
      ui.gray(
        "First run only asks for the provider execution permissions that AIRO must not assume.",
      ),
    ),
    ...paragraph(
      `${ui.gray("Inspect the current mapping with")} ${command("airo models")} ${ui.gray("and revisit permissions with")} ${command("airo setup")}.`,
    ),
    "",
  ];

  return lines.map(centered).join("\n");
}
