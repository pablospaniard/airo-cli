import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { VERSION } from "../version.js";

test("keeps package and documented versions aligned", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const readme = fs.readFileSync("README.md", "utf8");

  assert.equal(VERSION, "0.7.1");
  assert.equal(packageJson.version, VERSION);
  assert.equal(packageJson.name, "airo-ai-router");
  assert.equal(packageJson.bin.airo, "dist/cli.js");
  assert.equal(packageJson.bin["ai-router"], "dist/cli.js");
  assert.match(readme, /^<h1 align="center">AIRO<\/h1>$/m);
});
