import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunInitialSetup, shouldShowWelcome } from "../startup.js";

test("launches permission setup only before a first interactive provider run", () => {
  assert.equal(shouldRunInitialSetup([], true, false), true);
  assert.equal(shouldRunInitialSetup(["fix", "the", "bug"], true, false), true);
  assert.equal(shouldRunInitialSetup(["doctor"], true, false), false);
  assert.equal(shouldRunInitialSetup(["sync", "status"], true, false), false);
  assert.equal(shouldRunInitialSetup(["session"], true, false), false);
  assert.equal(shouldRunInitialSetup(["session", "new", "fix bug"], true, false), true);
  assert.equal(shouldRunInitialSetup([], false, false), false);
  assert.equal(shouldRunInitialSetup([], true, true), false);
  assert.equal(shouldRunInitialSetup(["--help"], true, false), false);
  assert.equal(shouldRunInitialSetup(["setup"], true, false), false);
});

test("shows welcome only before the first interactive configuration", () => {
  assert.equal(shouldShowWelcome([], true), true);
  assert.equal(shouldShowWelcome(["doctor"], true), true);
  assert.equal(shouldShowWelcome([], true, true), false);
  assert.equal(shouldShowWelcome([], false), false);
  assert.equal(shouldShowWelcome(["--help"], true), false);
  assert.equal(shouldShowWelcome(["--version"], true), false);
});
