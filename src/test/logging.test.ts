import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findRunLogs,
  followFile,
  formatLocalTime,
  logsRoot,
  recentRunDirs,
  RunLogger,
  type PhaseLogMeta,
} from "../logging.js";

test("formats activity timestamps in the machine's local time", () => {
  const localDate = new Date(2026, 8, 20, 18, 30, 5);

  assert.equal(formatLocalTime(localDate), "18:30:05");
});

const meta: PhaseLogMeta = {
  phaseIndex: 1,
  phaseTotal: 2,
  phaseKind: "test",
  agent: "codex",
  model: "test-model",
  effort: "low",
  tier: "fast",
};

test("persists and renders every run-log event category", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-logging-"));
  const previousHome = process.env.HOME;
  const previousStreamProtocol = process.env.AIRO_STREAM_PROTOCOL;
  const originalWrite = process.stdout.write;
  let terminal = "";
  process.env.HOME = home;
  process.env.AIRO_STREAM_PROTOCOL = "1";
  process.stdout.write = ((chunk: any) => {
    terminal += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const logger = new RunLogger({
      runId: "run unsafe/name",
      sessionId: "session/name",
      level: "verbose",
    });
    logger.status("run started");
    logger.status("input received");
    logger.metadata("metadata");
    logger.phaseStart(meta);
    logger.rawEvent(meta, '{"event":true}');
    for (const category of [
      "message",
      "tool",
      "file",
      "error",
      "retry",
      "result",
      "system",
      "status",
    ]) {
      logger.progress(meta, `line one\r\nline two`, category);
    }
    logger.progress(meta, "   ");
    logger.stderr(meta, "stderr one\nstderr two");
    logger.question("Continue?");
    logger.phaseEnd(meta, 0, 1250);
    logger.finalOutput("## Done\n\n- passed");
    logger.finalOutput("  ");

    assert.match(terminal, /run started/);
    assert.match(terminal, /Input needed/);
    assert.match(terminal, /"sessionId":"session\/name"/);
    assert.ok(fs.existsSync(logger.combinedPath));
    assert.equal(fs.statSync(logger.runDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(logger.combinedPath).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(logger.phaseFile(meta), "utf8"), /stderr two/);
    assert.match(fs.readFileSync(logger.eventsFile(meta), "utf8"), /event/);
    assert.equal(
      fs.readFileSync(path.join(logger.runDir, "final-output.txt"), "utf8"),
      "## Done\n\n- passed\n",
    );
    assert.equal(fs.statSync(path.join(logger.runDir, "final-output.txt")).mode & 0o777, 0o600);
    assert.equal(findRunLogs("run-unsafe-name"), logger.runDir);
    assert.equal(findRunLogs("missing"), undefined);
    assert.equal(recentRunDirs(1)[0].path, logger.runDir);
    assert.equal(logsRoot(), path.join(home, ".local", "share", "airo", "logs"));

    const quiet = new RunLogger({ runId: "quiet", level: "compact", persist: false });
    quiet.progress(meta, "hidden", "message");
    quiet.stderr(meta, "hidden");
  } finally {
    process.stdout.write = originalWrite;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStreamProtocol === undefined) delete process.env.AIRO_STREAM_PROTOCOL;
    else process.env.AIRO_STREAM_PROTOCOL = previousStreamProtocol;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-announces the route so clients repaint after a provider handover", () => {
  const previousStreamProtocol = process.env.AIRO_STREAM_PROTOCOL;
  const originalWrite = process.stdout.write;
  let terminal = "";
  process.env.AIRO_STREAM_PROTOCOL = "1";
  process.stdout.write = ((chunk: any) => {
    terminal += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const logger = new RunLogger({ runId: "switch", level: "verbose", persist: false });
    logger.providerSwitch(
      { ...meta, agent: "claude", model: "haiku" },
      "codex authentication failure detected → falling back to claude/haiku",
    );

    const events = terminal
      .split("\n")
      .filter((line) => line.startsWith("AIRO_EVENT "))
      .map((line) => JSON.parse(line.slice("AIRO_EVENT ".length)) as Record<string, unknown>);
    assert.deepEqual(
      events.map((event) => event.type),
      ["route", "phase"],
    );
    assert.ok(events.every((event) => event.provider === "claude"));
    assert.equal(events[0].model, "haiku");
    assert.equal(events[1].state, "started");
    assert.match(terminal, /falling back to claude\/haiku/);
    assert.match(terminal, /now running/);
  } finally {
    process.stdout.write = originalWrite;
    if (previousStreamProtocol === undefined) delete process.env.AIRO_STREAM_PROTOCOL;
    else process.env.AIRO_STREAM_PROTOCOL = previousStreamProtocol;
  }
});

test("follows a log until interrupted and rejects missing files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-follow-"));
  const file = path.join(dir, "combined.log");
  const originalWrite = process.stdout.write;
  let terminal = "";
  process.stdout.write = ((chunk: any) => {
    terminal += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await assert.rejects(followFile(path.join(dir, "missing")), /Log file not found/);
    fs.writeFileSync(file, "first\n");
    const following = followFile(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(file, "second\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit("SIGINT");
    await following;
    assert.match(terminal, /first/);
    assert.match(terminal, /second/);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
