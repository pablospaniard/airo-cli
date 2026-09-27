import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportLearningArchive, importLearningArchive } from "../history-archive.js";
import { appendFeedback, appendHistory, readFeedback, readHistory } from "../history.js";
import type { HistoryConfig, HistoryRecord } from "../types.js";

const PASSPHRASE = "correct horse battery staple";

function historyConfig(file: string): HistoryConfig {
  return {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.25,
    path: file,
  };
}

function record(cwd: string): HistoryRecord {
  return {
    id: "phase-one",
    runId: "run-one",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
    task: "private portable task",
    agent: "codex",
    modelTier: "balanced",
    model: "model",
    effort: "medium",
    complexity: 2,
    exitCode: 0,
    durationMs: 10,
  };
}

test("exports encrypted evidence and imports it idempotently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-history-archive-"));
  const source = historyConfig(path.join(dir, "source", "history.jsonl"));
  const destination = historyConfig(path.join(dir, "destination", "history.jsonl"));
  const project = path.join(dir, "project");
  const archive = path.join(dir, "portable.airo");
  fs.mkdirSync(project);
  try {
    appendHistory(source, record(project));
    appendFeedback(source, {
      id: "feedback-one",
      timestamp: "2026-01-02T00:00:00.000Z",
      scope: "run",
      targetId: "run-one",
      rating: "good",
      source: "explicit",
      confidence: 1,
    });

    const exported = exportLearningArchive(source, archive, PASSPHRASE);
    assert.equal(exported.history.total, 1);
    assert.equal(exported.feedback.total, 1);
    assert.doesNotMatch(fs.readFileSync(archive, "utf8"), /private portable task/);
    assert.throws(() => exportLearningArchive(source, archive, PASSPHRASE), /already exists/);
    assert.throws(
      () => importLearningArchive(destination, archive, "incorrect passphrase"),
      /Unable to decrypt/,
    );

    const imported = importLearningArchive(destination, archive, PASSPHRASE);
    assert.deepEqual(imported.history, { imported: 1, skipped: 0, total: 1 });
    assert.deepEqual(imported.feedback, { imported: 1, skipped: 0, total: 1 });
    assert.equal(readHistory(destination)[0].schemaVersion, 1);
    assert.match(readHistory(destination)[0].repositoryId!, /^(?:git|local)-v1:/);
    assert.equal(readFeedback(destination)[0].schemaVersion, 1);

    const repeated = importLearningArchive(destination, archive, PASSPHRASE);
    assert.deepEqual(repeated.history, { imported: 0, skipped: 1, total: 1 });
    assert.deepEqual(repeated.feedback, { imported: 0, skipped: 1, total: 1 });
    assert.equal(repeated.evidenceDigest, imported.evidenceDigest);
    assert.deepEqual(repeated.backupFiles, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrades legacy records during export and rejects conflicting immutable IDs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-history-conflict-"));
  const source = historyConfig(path.join(dir, "source", "history.jsonl"));
  const destination = historyConfig(path.join(dir, "destination", "history.jsonl"));
  const archive = path.join(dir, "portable.airo");
  const legacy = record(path.join(dir, "project"));
  fs.mkdirSync(legacy.cwd);
  fs.mkdirSync(path.dirname(source.path!));
  fs.writeFileSync(source.path!, `${JSON.stringify(legacy)}\n`);
  try {
    exportLearningArchive(source, archive, PASSPHRASE);
    fs.mkdirSync(path.dirname(destination.path!), { recursive: true });
    fs.writeFileSync(destination.path!, `${JSON.stringify(legacy)}\n`);
    const duplicateLegacy = importLearningArchive(destination, archive, PASSPHRASE);
    assert.deepEqual(duplicateLegacy.history, { imported: 0, skipped: 1, total: 1 });

    fs.writeFileSync(destination.path!, `${JSON.stringify({ ...legacy, task: "different" })}\n`);
    assert.throws(
      () => importLearningArchive(destination, archive, PASSPHRASE),
      /ID phase-one conflicts/,
    );
    assert.throws(
      () => exportLearningArchive(source, path.join(dir, "short.airo"), "too short"),
      /at least 12/,
    );
    fs.writeFileSync(source.path!, `${JSON.stringify({ ...legacy, schemaVersion: 99 })}\n`);
    assert.throws(
      () => exportLearningArchive(source, path.join(dir, "future.airo"), PASSPHRASE),
      /Unsupported history schema version: 99/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
