import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendTurn,
  clearActiveSession,
  compactSessionContext,
  createSession,
  getActiveSession,
  listSessions,
  loadSession,
  loadSessionTranscript,
  saveSession,
  setActiveSession,
  summarizeOutputForContext,
} from "../session.js";

test("summarizes output by sections without duplicating the decision or log tail", () => {
  const output = [
    "Plan: update the session context picker.",
    "Implementation details: preserve the final decision.",
    "test output only\n".repeat(80),
    "Decision: keep the plan and verification result.",
  ].join("\n\n");
  const summary = summarizeOutputForContext(output, 1200);
  assert.equal(summary.match(/Decision: keep the plan/g)?.length, 1);
  assert.match(summary, /Plan: update the session context picker/);
  assert.doesNotMatch(summary, /test output only\n.*test output only/);
});

test("manages the complete session lifecycle", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-session-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd);
  try {
    const session = createSession("original task", cwd);
    const dataDir = path.join(home, ".local", "share", "airo");
    const sessionsDir = path.join(dataDir, "sessions");
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sessionsDir).mode & 0o777, 0o700);
    assert.equal(
      fs.statSync(path.join(sessionsDir, `${session.sessionId}.json`)).mode & 0o777,
      0o600,
    );
    assert.equal(fs.statSync(path.join(dataDir, "active-sessions.json")).mode & 0o777, 0o600);
    assert.equal(getActiveSession(cwd)?.sessionId, session.sessionId);
    assert.equal(loadSession(session.sessionId).originalTask, "original task");

    appendTurn(session, {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      userPrompt: "follow up",
      routeSummary: "single:codex/model",
      phaseSummaries: ["first", "second"],
    });
    assert.deepEqual(
      loadSessionTranscript(session.sessionId).turns[0]?.finalOutput,
      "first\nsecond",
    );
    assert.match(compactSessionContext(session), /User follow-up: follow up/);
    saveSession(session);
    assert.equal(listSessions(cwd).length, 1);
    assert.equal(listSessions(path.join(home, "other")).length, 0);

    clearActiveSession(cwd);
    assert.equal(getActiveSession(cwd), undefined);
    setActiveSession(cwd, "missing");
    assert.equal(getActiveSession(cwd), undefined);
    assert.throws(() => loadSession("missing"), /Session not found/);

    fs.writeFileSync(path.join(sessionsDir, "bad.json"), "bad json");
    assert.equal(listSessions(cwd).length, 1);
    fs.writeFileSync(
      path.join(home, ".local", "share", "airo", "active-sessions.json"),
      "bad json",
    );
    assert.equal(getActiveSession(cwd), undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
