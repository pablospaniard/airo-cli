import assert from "node:assert/strict";
import test from "node:test";
import { plainText } from "../ui.js";
import { VERSION } from "../version.js";
import { firstRunWelcome } from "../welcome.js";

test("shows the logo, version, and hints for interactive and shell commands", () => {
  const width = 72;
  const welcome = plainText(firstRunWelcome(width));

  assert.match(welcome, /█████╗/);
  assert.match(welcome, /Adaptive Intelligence Routing & Orchestration/);
  assert.match(welcome, new RegExp(`Version ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(welcome, /Type \/ to see interactive commands\./);
  assert.match(welcome, /Exit and run airo help to see shell commands\./);

  assert.doesNotMatch(welcome, /Welcome/);
  assert.doesNotMatch(welcome, /Automatic discovery/);
  assert.doesNotMatch(welcome, /existing provider CLI logins/);
  assert.doesNotMatch(welcome, /execution permissions/);

  const midpoint = (line: string) => line.search(/\S/) + line.trim().length / 2;
  const lines = welcome.split("\n");
  const logoLine = lines.find((line) => line.includes("█████╗"));
  const subtitleLine = lines.find((line) => line.includes("Adaptive Intelligence"));
  const hintLine = lines.find((line) => line.includes("interactive commands"));
  const shellHintLine = lines.find((line) => line.includes("shell commands"));
  assert.ok(logoLine && subtitleLine && hintLine && shellHintLine);
  assert.ok(Math.abs(midpoint(logoLine) - midpoint(subtitleLine)) <= 0.5);
  assert.ok(Math.abs(midpoint(subtitleLine) - midpoint(hintLine)) <= 0.5);
  assert.ok(Math.abs(midpoint(hintLine) - midpoint(shellHintLine)) <= 0.5);

  const contentLines = lines.filter((line) => line.trim());
  assert.ok(contentLines.every((line) => line.length <= width));
});
