import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validAgent, validModelTier } from "./config.js";
import {
  FEEDBACK_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  feedbackPath,
  historyPath,
  readFeedback,
  readHistory,
} from "./history.js";
import { withFileLocks } from "./file-lock.js";
import { resolveRepositoryIdentity } from "./repository.js";
import type { FeedbackRecord, HistoryConfig, HistoryRecord } from "./types.js";

export const LEARNING_ARCHIVE_VERSION = 1;
const ARCHIVE_FORMAT = "airo-portable-learning";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

interface LearningArchivePayload {
  schemaVersion: number;
  exportedAt: string;
  history: HistoryRecord[];
  feedback: FeedbackRecord[];
}

interface EncryptedLearningArchive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

export interface LearningArchiveResult {
  history: { imported: number; skipped: number; total: number };
  feedback: { imported: number; skipped: number; total: number };
  evidenceDigest: string;
  backupFiles: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function evidenceDigest(history: HistoryRecord[], feedback: FeedbackRecord[]): string {
  return crypto.createHash("sha256").update(canonical({ history, feedback })).digest("hex");
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 12)
    throw new Error("Archive passphrase must contain at least 12 characters.");
}

function normalizeHistory(
  record: HistoryRecord,
  config: HistoryConfig,
  migratedRepositoryId?: string,
): HistoryRecord {
  if (record.schemaVersion !== undefined && record.schemaVersion !== HISTORY_SCHEMA_VERSION)
    throw new Error(`Unsupported history schema version: ${record.schemaVersion}.`);
  if (
    !record?.id ||
    !record.timestamp ||
    !record.cwd ||
    !record.task ||
    !validAgent(record.agent) ||
    !validModelTier(record.modelTier) ||
    typeof record.exitCode !== "number" ||
    typeof record.durationMs !== "number"
  )
    throw new Error(`Archive contains an invalid history record (${record?.id ?? "unknown ID"}).`);
  if (
    record.repositoryId !== undefined &&
    !/^(?:git-v1:[a-f0-9]{64}|local-v1:[0-9a-f-]{36})$/.test(record.repositoryId)
  )
    throw new Error("Archive contains an invalid repository ID.");
  return {
    ...record,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    repositoryId:
      record.repositoryId ??
      migratedRepositoryId ??
      resolveRepositoryIdentity(record.cwd, path.dirname(historyPath(config))).id,
  };
}

function normalizeFeedback(record: FeedbackRecord): FeedbackRecord {
  if (record.schemaVersion !== undefined && record.schemaVersion !== FEEDBACK_SCHEMA_VERSION)
    throw new Error(`Unsupported feedback schema version: ${record.schemaVersion}.`);
  if (
    !record?.id ||
    !record.timestamp ||
    !["run", "phase"].includes(record.scope) ||
    !record.targetId ||
    !["good", "bad"].includes(record.rating) ||
    !["explicit", "implicit"].includes(record.source) ||
    typeof record.confidence !== "number" ||
    record.confidence < 0 ||
    record.confidence > 1
  )
    throw new Error(`Archive contains an invalid feedback record (${record?.id ?? "unknown ID"}).`);
  return { ...record, schemaVersion: FEEDBACK_SCHEMA_VERSION };
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  parameters: { N: number; r: number; p: number },
): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { ...parameters, maxmem: 64 * 1024 * 1024 });
}

export function exportLearningArchive(
  config: HistoryConfig,
  outputFile: string,
  passphrase: string,
  options: { overwrite?: boolean } = {},
): LearningArchiveResult {
  assertPassphrase(passphrase);
  const target = path.resolve(outputFile);
  if (fs.existsSync(target) && !options.overwrite)
    throw new Error(`Archive already exists: ${target}. Use --force to replace it.`);

  const { history, feedback } = withFileLocks(
    [`${historyPath(config)}.lock`, `${feedbackPath(config)}.lock`],
    () => ({
      history: readHistory(config)
        .map((record) => normalizeHistory(record, config))
        .sort(compareEvidence),
      feedback: readFeedback(config).map(normalizeFeedback).sort(compareEvidence),
    }),
  );
  const payload: LearningArchivePayload = {
    schemaVersion: LEARNING_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    history,
    feedback,
  };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const parameters = { N: 16_384, r: 8, p: 1 };
  const key = deriveKey(passphrase, salt, parameters);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const archive: EncryptedLearningArchive = {
    format: ARCHIVE_FORMAT,
    version: LEARNING_ARCHIVE_VERSION,
    kdf: { name: "scrypt", salt: salt.toString("base64"), ...parameters },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(archive)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return {
    history: { imported: 0, skipped: 0, total: history.length },
    feedback: { imported: 0, skipped: 0, total: feedback.length },
    evidenceDigest: evidenceDigest(history, feedback),
    backupFiles: [],
  };
}

function decryptArchive(inputFile: string, passphrase: string): LearningArchivePayload {
  assertPassphrase(passphrase);
  const source = path.resolve(inputFile);
  const stat = fs.statSync(source);
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 64 MiB safety limit.");
  const archive = JSON.parse(fs.readFileSync(source, "utf8")) as EncryptedLearningArchive;
  if (
    archive.format !== ARCHIVE_FORMAT ||
    archive.version !== LEARNING_ARCHIVE_VERSION ||
    archive.kdf?.name !== "scrypt" ||
    archive.cipher?.name !== "aes-256-gcm"
  )
    throw new Error("Unsupported learning archive format or version.");
  if (
    archive.kdf.N !== 16_384 ||
    archive.kdf.r !== 8 ||
    archive.kdf.p !== 1 ||
    typeof archive.ciphertext !== "string"
  )
    throw new Error("Unsupported archive encryption parameters.");
  try {
    const key = deriveKey(passphrase, Buffer.from(archive.kdf.salt, "base64"), archive.kdf);
    const tag = Buffer.from(archive.cipher.tag, "base64");
    if (tag.length !== 16) throw new Error("Invalid authentication tag.");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(archive.cipher.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(archive.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as LearningArchivePayload;
    if (
      payload.schemaVersion !== LEARNING_ARCHIVE_VERSION ||
      !Array.isArray(payload.history) ||
      !Array.isArray(payload.feedback)
    )
      throw new Error("Invalid payload.");
    return payload;
  } catch {
    throw new Error("Unable to decrypt archive. Check the passphrase and archive integrity.");
  }
}

function compareEvidence(
  a: { timestamp: string; id: string },
  b: { timestamp: string; id: string },
) {
  return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

function mergeEvidence<T extends { id: string }>(
  current: T[],
  incoming: T[],
  label: string,
): { records: T[]; imported: number; skipped: number } {
  const byId = new Map(current.map((record) => [record.id, record]));
  let imported = 0;
  let skipped = 0;
  for (const record of incoming) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      imported++;
    } else if (canonical(existing) === canonical(record)) skipped++;
    else throw new Error(`Archive ${label} ID ${record.id} conflicts with local evidence.`);
  }
  return { records: [...byId.values()], imported, skipped };
}

function immutableHistory(
  record: HistoryRecord,
): Omit<HistoryRecord, "updatedAt" | "feedback" | "feedbackNote" | "evaluation" | "outcome"> {
  const {
    updatedAt: _updatedAt,
    feedback: _feedback,
    feedbackNote: _feedbackNote,
    evaluation: _evaluation,
    outcome: _outcome,
    ...immutable
  } = record;
  return immutable;
}

function mergeHistoryEvidence(
  current: HistoryRecord[],
  incoming: HistoryRecord[],
): { records: HistoryRecord[]; imported: number; skipped: number } {
  const byId = new Map(current.map((record) => [record.id, record]));
  let imported = 0;
  let skipped = 0;
  for (const record of incoming) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      imported++;
      continue;
    }
    if (canonical(existing) === canonical(record)) {
      skipped++;
      continue;
    }
    if (canonical(immutableHistory(existing)) !== canonical(immutableHistory(record)))
      throw new Error(`Archive history ID ${record.id} conflicts with local evidence.`);
    const existingUpdated = Date.parse(existing.updatedAt ?? "");
    const incomingUpdated = Date.parse(record.updatedAt ?? "");
    if (
      Number.isFinite(incomingUpdated) &&
      (!Number.isFinite(existingUpdated) || incomingUpdated > existingUpdated)
    ) {
      byId.set(record.id, record);
      imported++;
    } else if (
      Number.isFinite(existingUpdated) &&
      (!Number.isFinite(incomingUpdated) || existingUpdated > incomingUpdated)
    ) {
      skipped++;
    } else {
      throw new Error(`Archive history ID ${record.id} has conflicting mutable evidence.`);
    }
  }
  return { records: [...byId.values()], imported, skipped };
}

function writeJsonLines(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(
    temporary,
    records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
    { mode: 0o600 },
  );
  fs.renameSync(temporary, file);
}

export function importLearningArchive(
  config: HistoryConfig,
  inputFile: string,
  passphrase: string,
): LearningArchiveResult {
  const payload = decryptArchive(inputFile, passphrase);
  const historyFile = historyPath(config);
  const feedbackFile = feedbackPath(config);
  return withFileLocks([`${historyFile}.lock`, `${feedbackFile}.lock`], () => {
    const incomingRepositoryIds = new Map(
      payload.history.map((record) => [record.id, record.repositoryId]),
    );
    const localHistory = readHistory(config).map((record) =>
      normalizeHistory(record, config, incomingRepositoryIds.get(record.id)),
    );
    const localFeedback = readFeedback(config).map(normalizeFeedback);
    const incomingHistory = payload.history.map((record) => normalizeHistory(record, config));
    const incomingFeedback = payload.feedback.map(normalizeFeedback);
    const history = mergeHistoryEvidence(localHistory, incomingHistory);
    const feedback = mergeEvidence(localFeedback, incomingFeedback, "feedback");
    const mergedHistory = history.records.sort(compareEvidence);
    const mergedFeedback = feedback.records.sort(compareEvidence);
    const phaseIds = new Set(mergedHistory.map((record) => record.id));
    const runIds = new Set(mergedHistory.map((record) => record.runId ?? record.id));
    for (const record of incomingFeedback) {
      const exists =
        record.scope === "phase" ? phaseIds.has(record.targetId) : runIds.has(record.targetId);
      if (!exists) throw new Error(`Archive feedback ${record.id} references missing evidence.`);
    }
    const backups: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (history.imported || feedback.imported) {
      for (const file of [historyFile, feedbackFile]) {
        if (!fs.existsSync(file)) continue;
        const backup = `${file}.before-import-${stamp}`;
        fs.copyFileSync(file, backup);
        backups.push(backup);
      }
      writeJsonLines(historyFile, mergedHistory);
      writeJsonLines(feedbackFile, mergedFeedback);
    }

    return {
      history: {
        imported: history.imported,
        skipped: history.skipped,
        total: mergedHistory.length,
      },
      feedback: {
        imported: feedback.imported,
        skipped: feedback.skipped,
        total: mergedFeedback.length,
      },
      evidenceDigest: evidenceDigest(mergedHistory, mergedFeedback),
      backupFiles: backups,
    };
  });
}
