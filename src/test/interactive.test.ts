import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanDroppedPath,
  INTERACTIVE_SHELL_HELP,
  isSupportedAttachmentPath,
  parseFeedbackAnswer,
  parseInteractiveInput,
  taskArgs,
} from "../interactive.js";

test("normalizes paths pasted by terminal drag and drop", () => {
  assert.equal(cleanDroppedPath('"/tmp/My Notes/report.pdf"'), "/tmp/My Notes/report.pdf");
  assert.equal(cleanDroppedPath("'/tmp/photo.png'"), "/tmp/photo.png");
  assert.equal(isSupportedAttachmentPath("/tmp/report.pdf"), true);
  assert.equal(isSupportedAttachmentPath("/tmp/report.txt"), false);
});

test("treats regular interactive input as a task", () => {
  assert.deepEqual(parseInteractiveInput("  fix the parser  "), {
    kind: "task",
    task: "fix the parser",
  });
  assert.deepEqual(parseInteractiveInput("--no-jev keep this local"), {
    kind: "task",
    task: "keep this local",
    noJev: true,
  });
  assert.deepEqual(parseInteractiveInput("/no-jev keep this local"), {
    kind: "task",
    task: "keep this local",
    noJev: true,
  });
});

test("parses interactive preference commands", () => {
  assert.deepEqual(parseInteractiveInput("/mode adaptive"), {
    kind: "set-mode",
    value: "adaptive",
  });
  assert.deepEqual(parseInteractiveInput("/agent claude"), { kind: "set-agent", value: "claude" });
  assert.deepEqual(parseInteractiveInput("/tier auto"), { kind: "set-tier", value: undefined });
  assert.deepEqual(parseInteractiveInput("/log verbose"), { kind: "set-log", value: "verbose" });
  assert.deepEqual(parseInteractiveInput(""), { kind: "empty" });
  assert.deepEqual(parseInteractiveInput("/exit"), { kind: "quit" });
  assert.deepEqual(parseInteractiveInput("/quit"), { kind: "quit" });
  assert.deepEqual(parseInteractiveInput("/?"), { kind: "help" });
  assert.deepEqual(parseInteractiveInput("/status"), { kind: "status" });
  assert.deepEqual(parseInteractiveInput("/sessions"), { kind: "sessions" });
  assert.deepEqual(parseInteractiveInput("/models"), { kind: "models" });
  assert.deepEqual(parseInteractiveInput("/account"), { kind: "account" });
  assert.deepEqual(parseInteractiveInput("/usage 5"), { kind: "usage", limit: 5 });
  assert.deepEqual(parseInteractiveInput("/usage cost weekly"), {
    kind: "usage",
    costPeriod: "weekly",
  });
  assert.deepEqual(parseInteractiveInput("/logs"), { kind: "logs" });
  assert.deepEqual(parseInteractiveInput("/attach /tmp/screenshot.png"), {
    kind: "attach",
    path: "/tmp/screenshot.png",
  });
  assert.deepEqual(parseInteractiveInput("/attach /tmp/notes.md"), {
    kind: "attach",
    path: "/tmp/notes.md",
  });
  assert.deepEqual(parseInteractiveInput("/feedback good shipped"), {
    kind: "feedback",
    rating: "good",
    note: "shipped",
  });
  assert.deepEqual(parseInteractiveInput("/feedback phase abc bad retry"), {
    kind: "feedback",
    phaseId: "abc",
    rating: "bad",
    note: "retry",
  });
  assert.deepEqual(parseInteractiveInput("/learning"), { kind: "learning", action: "status" });
  assert.deepEqual(parseInteractiveInput("/learning explain abc"), {
    kind: "learning",
    action: "explain",
    targetId: "abc",
  });
  assert.deepEqual(parseInteractiveInput("/learning reset --yes"), {
    kind: "learning",
    action: "reset",
    confirmed: true,
  });
  assert.deepEqual(parseInteractiveInput("/clear"), { kind: "clear" });
  assert.deepEqual(parseInteractiveInput("/new named session"), {
    kind: "new",
    title: "named session",
  });
  assert.deepEqual(parseInteractiveInput("/new"), { kind: "new", title: undefined });
  assert.deepEqual(parseInteractiveInput("/mode single"), { kind: "set-mode", value: "single" });
  assert.deepEqual(parseInteractiveInput("/agent auto"), { kind: "set-agent", value: "auto" });
  assert.deepEqual(parseInteractiveInput("/tier deep"), { kind: "set-tier", value: "deep" });
  assert.deepEqual(parseInteractiveInput("/log compact"), { kind: "set-log", value: "compact" });
});

test("returns guidance for invalid interactive commands", () => {
  assert.deepEqual(parseInteractiveInput("/mode fast"), {
    kind: "error",
    message: "Usage: /mode auto|adaptive|single",
  });
  assert.match(parseInteractiveInput("/agent other").kind, /error/);
  assert.match(parseInteractiveInput("/tier other").kind, /error/);
  assert.match(parseInteractiveInput("/log other").kind, /error/);
  assert.match(parseInteractiveInput("/feedback phase abc maybe").kind, /error/);
  assert.match(parseInteractiveInput("/feedback maybe").kind, /error/);
  assert.match(parseInteractiveInput("/learning explain").kind, /error/);
  assert.match(parseInteractiveInput("--no-jev").kind, /error/);
  assert.match(parseInteractiveInput("/no-jev").kind, /error/);
  assert.match(parseInteractiveInput("/wat").kind, /error/);
});

test("advertises shell-only Jev and sync command families from interactive help", () => {
  const commands = INTERACTIVE_SHELL_HELP.map(([command]) => command).join("\n");
  assert.match(commands, /airo feedback jev status\|enable\|disable/);
  assert.match(commands, /airo feedback jev inspect\|reset/);
  assert.match(commands, /airo sync login\|enable\|now\|status/);
  assert.match(commands, /airo sync devices\|export\|logout/);
  assert.match(commands, /airo sync delete-cloud-data --yes/);
});

test("builds minimal CLI arguments for automatic preferences", () => {
  assert.deepEqual(taskArgs("inspect", { mode: "auto", agent: "auto", logLevel: "live" }), [
    "--continue",
    "--log",
    "live",
    "inspect",
  ]);
  assert.deepEqual(taskArgs("inspect", { mode: "single", agent: "claude", logLevel: "live" }), [
    "--continue",
    "--single",
    "--prefer-agent",
    "claude",
    "--log",
    "live",
    "inspect",
  ]);
  assert.equal(parseFeedbackAnswer("n"), "bad");
  assert.equal(parseFeedbackAnswer("maybe"), undefined);
});

test("builds CLI arguments from interactive preferences", () => {
  assert.deepEqual(
    taskArgs("ship it", {
      mode: "adaptive",
      agent: "codex",
      tier: "deep",
      logLevel: "compact",
    }),
    [
      "--continue",
      "--adaptive",
      "--prefer-agent",
      "codex",
      "--prefer-tier",
      "deep",
      "--log",
      "compact",
      "ship it",
    ],
  );
  assert.deepEqual(
    taskArgs("keep this local", { mode: "auto", agent: "auto", logLevel: "live" }, { noJev: true }),
    ["--continue", "--no-jev", "--log", "live", "keep this local"],
  );
});

test("parses simple post-run feedback", () => {
  assert.equal(parseFeedbackAnswer("yes"), "good");
  assert.equal(parseFeedbackAnswer("Y"), "good");
  assert.equal(parseFeedbackAnswer("no"), "bad");
  assert.equal(parseFeedbackAnswer(""), undefined);
});
