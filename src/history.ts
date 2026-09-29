import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  Agent,
  FeedbackRating,
  FeedbackRecord,
  FeedbackScope,
  HistoryConfig,
  HistoryRecord,
  ModelTier,
} from "./types.js";
import { dataRootDir } from "./paths.js";
import { enrichHistoryRecord, extractTaskFeatures } from "./evaluation.js";
import { resolveRepositoryIdentity } from "./repository.js";
import { withFileLock, withFileLocks } from "./file-lock.js";
import { recordSyncDeletions } from "./sync-deletions.js";

export const HISTORY_SCHEMA_VERSION = 1;
export const FEEDBACK_SCHEMA_VERSION = 1;

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "it",
  "is",
  "are",
  "be",
  "from",
  "by",
  "as",
  "at",
  "we",
  "i",
  "my",
  "our",
  "please",
  "can",
  "you",
  "into",
]);

export function historyPath(config: HistoryConfig): string {
  return config.path ?? path.join(dataRootDir(), "history.jsonl");
}

export function newHistoryId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function newRunId(): string {
  return crypto.randomBytes(6).toString("hex");
}

function latestLocalHistoryPath(config: HistoryConfig): string {
  return `${historyPath(config)}.latest-local.json`;
}

function writeAtomic(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function writeHistory(file: string, records: HistoryRecord[]): void {
  writeAtomic(
    file,
    records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
  );
}

function latestLocalRecord(config: HistoryConfig, records: HistoryRecord[]): HistoryRecord {
  try {
    const marker = JSON.parse(fs.readFileSync(latestLocalHistoryPath(config), "utf8")) as {
      id?: string;
    };
    const local = records.find((record) => record.id === marker.id);
    if (local) return local;
  } catch {}
  return [...records]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
    .at(-1)!;
}

export function appendHistory(config: HistoryConfig, record: HistoryRecord): void {
  if (!config.enabled) return;
  const file = historyPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const repositoryId =
    record.repositoryId ?? resolveRepositoryIdentity(record.cwd, path.dirname(file)).id;
  withFileLock(`${file}.lock`, () => {
    const saved = enrichHistoryRecord({
      ...record,
      schemaVersion: HISTORY_SCHEMA_VERSION,
      repositoryId,
    });
    fs.appendFileSync(file, JSON.stringify(saved) + "\n");
    writeAtomic(latestLocalHistoryPath(config), `${JSON.stringify({ id: saved.id })}\n`);
  });
}

export function feedbackPath(config: HistoryConfig): string {
  const history = historyPath(config);
  return history.endsWith(".jsonl")
    ? history.replace(/\.jsonl$/, ".feedback.jsonl")
    : `${history}.feedback.jsonl`;
}

export function readFeedback(config: HistoryConfig): FeedbackRecord[] {
  if (!config.enabled) return [];
  const file = feedbackPath(config);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line: string) => {
      try {
        return [JSON.parse(line) as FeedbackRecord];
      } catch {
        return [];
      }
    });
}

export function appendFeedback(config: HistoryConfig, feedback: FeedbackRecord): void {
  if (!config.enabled) return;
  const file = feedbackPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(`${file}.lock`, () =>
    fs.appendFileSync(
      file,
      JSON.stringify({ ...feedback, schemaVersion: FEEDBACK_SCHEMA_VERSION }) + "\n",
    ),
  );
}

export function setScopedFeedback(
  config: HistoryConfig,
  rating: FeedbackRating,
  options: {
    scope?: FeedbackScope;
    targetId?: string;
    note?: string;
    source?: "explicit" | "implicit";
    confidence?: number;
  } = {},
): FeedbackRecord {
  const scope = options.scope ?? "run";
  const targetId = withFileLock(`${historyPath(config)}.lock`, () => {
    const records = readHistory(config);
    if (!records.length) throw new Error("No routing history yet.");
    const latest = latestLocalRecord(config, records);
    const selected =
      options.targetId ?? (scope === "run" ? (latest.runId ?? latest.id) : latest.id);
    const exists =
      scope === "run"
        ? records.some(
            (record) => record.runId === selected || (!record.runId && record.id === selected),
          )
        : records.some((record) => record.id === selected);
    if (!exists) throw new Error(`${scope === "run" ? "Run" : "Phase"} ${selected} not found.`);
    return selected;
  });
  const feedback: FeedbackRecord = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: newHistoryId(),
    timestamp: new Date().toISOString(),
    scope,
    targetId,
    rating,
    source: options.source ?? "explicit",
    note: options.note,
    confidence: options.confidence ?? (options.source === "implicit" ? 0.45 : 1),
  };
  appendFeedback(config, feedback);
  return feedback;
}

/** Record only high-signal corrective follow-ups; silence is deliberately not treated as approval. */
export function recordImplicitCorrection(
  config: HistoryConfig,
  priorRunId: string | undefined,
  followUp: string,
): FeedbackRecord | undefined {
  if (!priorRunId) return undefined;
  if (
    !/\b(?:fix (?:that|it)|that's wrong|that is wrong|still (?:broken|failing|wrong)|undo|revert|try again|didn't work|doesn't work)\b/i.test(
      followUp,
    )
  )
    return undefined;
  if (!readHistory(config).some((record) => (record.runId ?? record.id) === priorRunId))
    return undefined;
  const existing = readFeedback(config).some(
    (item) => item.scope === "run" && item.targetId === priorRunId && item.source === "explicit",
  );
  if (existing) return undefined;
  return setScopedFeedback(config, "bad", {
    scope: "run",
    targetId: priorRunId,
    source: "implicit",
    confidence: 0.45,
    note: "corrective follow-up detected",
  });
}

export function readHistory(config: HistoryConfig): HistoryRecord[] {
  if (!config.enabled) return [];
  const file = historyPath(config);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line: string) => {
      try {
        return [JSON.parse(line) as HistoryRecord];
      } catch {
        return [];
      }
    });
}

export function updateHistoryRecord(
  config: HistoryConfig,
  id: string,
  update: (record: HistoryRecord) => HistoryRecord,
): HistoryRecord | undefined {
  const file = historyPath(config);
  return withFileLock(`${file}.lock`, () => {
    const records = readHistory(config);
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;
    records[index] = { ...update(records[index]), updatedAt: new Date().toISOString() };
    writeHistory(file, records);
    return records[index];
  });
}

export function setFeedback(
  config: HistoryConfig,
  rating: FeedbackRating,
  id?: string,
  note?: string,
): HistoryRecord[] {
  const file = historyPath(config);
  return withFileLock(`${file}.lock`, () => {
    const records = readHistory(config);
    if (!records.length) throw new Error("No routing history yet.");
    let targets: number[] = [];

    if (!id || id === "last") {
      const last = latestLocalRecord(config, records);
      if (last.runId)
        targets = records.map((r, i) => (r.runId === last.runId ? i : -1)).filter((i) => i >= 0);
      else targets = [records.findIndex((record) => record.id === last.id)];
    } else {
      const byRun = records.map((r, i) => (r.runId === id ? i : -1)).filter((i) => i >= 0);
      if (byRun.length) targets = byRun;
      else {
        const index = records.findIndex((r) => r.id === id);
        if (index >= 0) targets = [index];
      }
    }
    if (!targets.length) throw new Error(`History item or run ${id} not found.`);

    for (const index of targets) {
      records[index] = {
        ...records[index],
        feedback: rating,
        feedbackNote: note,
        updatedAt: new Date().toISOString(),
      };
    }
    writeHistory(file, records);
    return targets.map((i) => records[i]);
  });
}

function tokens(s: string): Set<string> {
  const words = s.toLowerCase().match(/[a-z0-9_+#.-]{2,}/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w)));
}

export function similarity(a: string, b: string): number {
  const A = tokens(a),
    B = tokens(b);
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  const union = A.size + B.size - intersection;
  return union ? intersection / union : 0;
}

export interface LearningHint {
  agentBoosts: Record<Agent, number>;
  tierBoosts: Record<ModelTier, number>;
  notes: string[];
  confidence: number;
  observations: number;
  routeUtilities: Record<string, number>;
  routeSamples: Record<string, number>;
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  return Math.max(
    0,
    a.reduce((sum, value, index) => sum + value * b[index], 0),
  );
}

export function semanticSimilarity(task: string, record: HistoryRecord): number {
  const a = extractTaskFeatures(task);
  const b =
    record.taskFeatures ??
    extractTaskFeatures(record.originalTask ?? record.task, record.complexity);
  const lexical = similarity(task, record.originalTask ?? record.task);
  const semantic = lexical * 0.6 + cosine(a.embedding, b.embedding) * 0.3;
  if (semantic < 0.1) return semantic;
  const category = a.category === b.category ? 0.06 : 0;
  const language = a.language && b.language && a.language === b.language ? 0.02 : 0;
  const risk = a.risk === b.risk ? 0.02 : 0;
  return Math.min(1, semantic + category + language + risk);
}

function latestFeedback(
  record: HistoryRecord,
  feedback: FeedbackRecord[],
): FeedbackRecord | undefined {
  const latest = (items: FeedbackRecord[]) =>
    items.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  return (
    latest(feedback.filter((item) => item.scope === "phase" && item.targetId === record.id)) ??
    latest(
      feedback.filter(
        (item) => item.scope === "run" && item.targetId === (record.runId ?? record.id),
      ),
    )
  );
}

function creditFor(record: HistoryRecord): number {
  if (!record.phaseKind) return 1;
  if (record.phaseKind === "implement" || record.phaseKind === "recover") return 1;
  if (record.phaseKind === "test" || record.phaseKind === "review") return 0.8;
  return 0.6;
}

function rewardFor(
  record: HistoryRecord,
  feedback: FeedbackRecord[],
): { value: number; confidence: number; explicit: boolean } | undefined {
  const scoped = latestFeedback(record, feedback);
  if (scoped)
    return {
      value: (scoped.rating === "good" ? 1 : -1) * creditFor(record),
      confidence: scoped.confidence,
      explicit: scoped.source === "explicit",
    };
  if (record.feedback)
    return { value: record.feedback === "good" ? 1 : -1, confidence: 1, explicit: true };
  if (!record.evaluation || !record.outcome) return undefined;
  const value = record.evaluation.quality * 2 - 1 - Math.min(0.4, record.outcome.retries * 0.1);
  return { value, confidence: record.evaluation.confidence * 0.35, explicit: false };
}

export function learningHints(task: string, config: HistoryConfig): LearningHint {
  const maxAgentBoost = 8;
  const maxTierBoost = 6;
  const empty: LearningHint = {
    agentBoosts: { claude: 0, codex: 0, gemini: 0, copilot: 0 },
    tierBoosts: { fast: 0, balanced: 0, deep: 0 },
    notes: [],
    confidence: 0,
    observations: 0,
    routeUtilities: {},
    routeSamples: {},
  };
  if (!config.enabled || !config.learningEnabled) return empty;

  const feedback = readFeedback(config);
  const halfLife = Math.max(1, config.halfLifeDays ?? 90) * 86_400_000;
  const now = Date.now();
  const currentCwd = path.resolve(process.cwd());
  const currentRepositoryId = config.repositoryScoped
    ? resolveRepositoryIdentity(currentCwd, path.dirname(historyPath(config))).id
    : undefined;
  const similar = readHistory(config)
    .filter(
      (record) =>
        !config.repositoryScoped ||
        (record.repositoryId
          ? record.repositoryId === currentRepositoryId
          : path.resolve(record.cwd) === currentCwd),
    )
    .map((r) => ({ r, reward: rewardFor(r, feedback), sim: semanticSimilarity(task, r) }))
    .filter(
      (x): x is typeof x & { reward: { value: number; confidence: number; explicit: boolean } } =>
        Boolean(x.reward),
    )
    .filter((x) => x.sim >= config.similarityThreshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 30);

  let totalWeight = 0;
  const agentSamples: Record<Agent, number> = { claude: 0, codex: 0, gemini: 0, copilot: 0 };
  const tierSamples: Record<ModelTier, number> = { fast: 0, balanced: 0, deep: 0 };
  for (const { r, sim, reward } of similar) {
    const age = Math.max(0, now - new Date(r.timestamp).getTime());
    const decay = 2 ** (-age / halfLife);
    const weight = sim * reward.confidence * (reward.explicit ? Math.max(0.5, decay) : decay);
    totalWeight += weight;
    agentSamples[r.agent] += weight;
    tierSamples[r.modelTier] += weight;
    empty.agentBoosts[r.agent] = Math.max(
      -maxAgentBoost,
      Math.min(maxAgentBoost, empty.agentBoosts[r.agent] + reward.value * 4 * weight),
    );
    empty.tierBoosts[r.modelTier] = Math.max(
      -maxTierBoost,
      Math.min(maxTierBoost, empty.tierBoosts[r.modelTier] + reward.value * 3 * weight),
    );
    const key = `${r.agent}/${r.model}/${r.effort}`;
    const efficiency =
      1 -
      Math.min(0.35, (r.outcome?.tokens ?? 0) / 200_000) -
      Math.min(0.25, r.durationMs / 3_600_000);
    empty.routeUtilities[key] =
      (empty.routeUtilities[key] ?? 0) + (reward.value * 0.8 + efficiency * 0.2) * weight;
    empty.routeSamples[key] = (empty.routeSamples[key] ?? 0) + weight;
  }

  const minimumSamples = config.minimumSamples ?? 2;
  for (const agent of Object.keys(agentSamples) as Agent[])
    if (agentSamples[agent] < minimumSamples) empty.agentBoosts[agent] = 0;
  for (const tier of Object.keys(tierSamples) as ModelTier[])
    if (tierSamples[tier] < minimumSamples) empty.tierBoosts[tier] = 0;

  for (const key of Object.keys(empty.routeUtilities))
    empty.routeUtilities[key] /= Math.max(0.001, empty.routeSamples[key]);

  empty.observations = similar.length;
  empty.confidence = Math.min(1, totalWeight / Math.max(1, minimumSamples));

  if (similar.length) {
    const best = similar[0];
    empty.notes.push(
      `learned from ${similar.length} similar outcome(s); closest ${(best.sim * 100).toFixed(0)}%; confidence ${(empty.confidence * 100).toFixed(0)}%`,
    );
  }
  return empty;
}

export interface LearningStatus {
  phases: number;
  explicitFeedback: number;
  implicitFeedback: number;
  evaluatedPhases: number;
  routes: Array<{ route: string; samples: number; averageQuality: number }>;
}

export function learningStatus(config: HistoryConfig): LearningStatus {
  const records = readHistory(config);
  const feedback = readFeedback(config);
  const grouped = new Map<string, { count: number; quality: number }>();
  for (const record of records) {
    const key = `${record.agent}/${record.model}/${record.effort}`;
    const current = grouped.get(key) ?? { count: 0, quality: 0 };
    current.count++;
    current.quality += record.evaluation?.quality ?? (record.exitCode === 0 ? 0.6 : 0);
    grouped.set(key, current);
  }
  return {
    phases: records.length,
    explicitFeedback:
      feedback.filter((item) => item.source === "explicit").length +
      records.filter((record) => record.feedback).length,
    implicitFeedback: feedback.filter((item) => item.source === "implicit").length,
    evaluatedPhases: records.filter((record) => record.evaluation).length,
    routes: [...grouped.entries()]
      .map(([route, value]) => ({
        route,
        samples: value.count,
        averageQuality: value.quality / value.count,
      }))
      .sort((a, b) => b.samples - a.samples),
  };
}

export function explainLearning(
  config: HistoryConfig,
  targetId: string,
): { records: HistoryRecord[]; feedback: FeedbackRecord[] } {
  const records = readHistory(config).filter(
    (record) => record.id === targetId || record.runId === targetId,
  );
  if (!records.length) throw new Error(`Run or phase ${targetId} not found.`);
  const ids = new Set(records.map((record) => record.id));
  const runs = new Set(records.map((record) => record.runId ?? record.id));
  const feedback = readFeedback(config).filter((item) =>
    item.scope === "phase" ? ids.has(item.targetId) : runs.has(item.targetId),
  );
  return { records, feedback };
}

export function resetLearning(config: HistoryConfig): number {
  const feedbackFile = feedbackPath(config);
  const historyFile = historyPath(config);
  return withFileLocks([`${historyFile}.lock`, `${feedbackFile}.lock`], () => {
    const feedback = readFeedback(config);
    const count = feedback.length;
    recordSyncDeletions(
      historyFile,
      "feedback",
      feedback.map((record) => record.id),
    );
    if (fs.existsSync(feedbackFile)) fs.unlinkSync(feedbackFile);
    const updatedAt = new Date().toISOString();
    const records = readHistory(config).map((record) => {
      if (record.feedback === undefined && record.feedbackNote === undefined) return record;
      const { feedback: _feedback, feedbackNote: _note, ...withoutFeedback } = record;
      return { ...withoutFeedback, updatedAt };
    });
    if (records.length) writeHistory(historyFile, records);
    return count;
  });
}
