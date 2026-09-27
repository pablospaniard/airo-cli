import assert from "node:assert/strict";
import test from "node:test";
import { plainText } from "../ui.js";
import { VERSION } from "../version.js";
import { firstRunWelcome } from "../welcome.js";

test("introduces automatic discovery and permission setup on first run", () => {
  const welcome = plainText(firstRunWelcome());

  assert.match(welcome, /█████╗/);
  assert.match(welcome, /Adaptive Intelligence Routing & Orchestration/);
  assert.match(welcome, new RegExp(`Version ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(welcome, /existing provider CLI logins/);
  assert.match(welcome, /detects installed supported providers/);
  assert.match(welcome, /fast, balanced, and deep tiers/);
  assert.match(welcome, /execution permissions/);
  assert.doesNotMatch(welcome, /Next/);
  assert.match(welcome, /airo setup/);
  assert.match(welcome, /airo models/);

  const sectionTitles = welcome
    .split("\n")
    .filter((line) => /(?:Welcome|Automatic discovery)/.test(line));
  assert.equal(sectionTitles.length, 2);
  assert.equal(new Set(sectionTitles.map((line) => line.length)).size, 1);

  const midpoint = (line: string) => line.search(/\S/) + line.trim().length / 2;
  const lines = welcome.split("\n");
  const logoLine = lines.find((line) => line.includes("█████╗"));
  const subtitleLine = lines.find((line) => line.includes("Adaptive Intelligence"));
  assert.ok(logoLine && subtitleLine);
  assert.ok(Math.abs(midpoint(logoLine) - midpoint(sectionTitles[0])) <= 0.5);
  assert.ok(Math.abs(midpoint(subtitleLine) - midpoint(sectionTitles[0])) <= 0.5);
});
