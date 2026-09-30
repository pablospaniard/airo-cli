import { command, outputWidth, ui, visibleLength } from "./ui.js";
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

  const centered = (line: string) =>
    line
      ? `${" ".repeat(Math.max(0, Math.floor((width - visibleLength(line)) / 2)))}${line}`
      : line;

  const lines = [
    "",
    ...logo,
    ui.dim("Adaptive Intelligence Routing & Orchestration"),
    ui.gray(`Version ${VERSION}`),
    "",
    `${ui.gray("Type")} ${command("/")} ${ui.gray("to see interactive commands.")}`,
    `${ui.gray("Exit and run")} ${command("airo help")} ${ui.gray("to see shell commands.")}`,
    "",
  ];

  return lines.map(centered).join("\n");
}
