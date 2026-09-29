import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractTaskFeatures } from "./evaluation.js";
import { historyPath, newHistoryId, readFeedback, readHistory } from "./history.js";
import { withFileLock } from "./file-lock.js";
import { resolveRepositoryIdentity } from "./repository.js";
import type { Agent, HistoryConfig, HistoryRecord, ModelTier, TaskFeatures } from "./types.js";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_QUESTION_SET_VERSION = "1.0.0";
export const JEV_CONSENT_VERSION = 1;
export const JEV_FEEDBACK_SCHEMA_VERSION = 1;
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const JEV_DISCLOSURE = [
  "AIRO will send task text, phase/task features, selected route identifiers, and bucketed outcomes to TypeSafe Jev after a run.",
  "AIRO will not send source files, diffs, provider output, repository paths or remotes, credentials, environment variables, feedback notes, or session transcripts.",
  "The feature uses your TYPESAFE_API_KEY. AIRO reads it from the environment and never stores or synchronizes it.",
  "Jev feedback is stored locally and may only influence future unpinned automatic routes through bounded adjustments.",
] as const;

export interface JevConsent {
  schemaVersion: 1;
  enabled: boolean;
  noticeVersion: number;
  noticeHash: string;
  consentedAt?: string;
  disabledAt?: string;
}

interface ChoiceAnswer<T extends string> {
  type: "choice";
  choice: T;
  probabilities: Record<T, number>;
  confidence: number;
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevFeedbackRecord {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  sourceHistoryId: string;
  runId: string;
  repositoryId?: string;
  taskFeatures: TaskFeatures;
  selected: { agent: Agent; tier: ModelTier };
  suggested: { agent: Agent; tier: ModelTier };
  model: string;
  questionSetVersion: string;
  provider: ChoiceAnswer<Agent>;
  tier: ChoiceAnswer<ModelTier>;
  decisionAppropriate: NoulAnswer;
  acceptedIntoLearning: boolean;
  acceptanceReason: string;
}

export interface JevLearningHint {
  agentBoosts: Record<Agent, number>;
  tierBoosts: Record<ModelTier, number>;
  observations: number;
  confidence: number;
  notes: string[];
}

export type JevEvaluationResult =
  | { status: "saved"; records: JevFeedbackRecord[] }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

function noticeHash(): string {
  return crypto.createHash("sha256").update(JEV_DISCLOSURE.join("\n")).digest("hex");
}

function adjacentFile(config: HistoryConfig, suffix: string): string {
  const history = historyPath(config);
  return history.endsWith(".jsonl") ? history.replace(/\.jsonl$/, suffix) : `${history}${suffix}`;
}

export function jevConsentPath(config: HistoryConfig): string {
  return adjacentFile(config, ".jev-consent.json");
}

export function jevFeedbackPath(config: HistoryConfig): string {
  return adjacentFile(config, ".jev-feedback.jsonl");
}

export function readJevConsent(config: HistoryConfig): JevConsent | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(jevConsentPath(config), "utf8")) as JevConsent;
    if (value.schemaVersion !== JEV_CONSENT_VERSION || typeof value.enabled !== "boolean")
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function isJevEnabled(config: HistoryConfig): boolean {
  const consent = readJevConsent(config);
  return Boolean(
    config.enabled &&
    consent?.enabled &&
    consent.noticeVersion === JEV_CONSENT_VERSION &&
    consent.noticeHash === noticeHash(),
  );
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function enableJev(config: HistoryConfig): JevConsent {
  const consent: JevConsent = {
    schemaVersion: JEV_CONSENT_VERSION,
    enabled: true,
    noticeVersion: JEV_CONSENT_VERSION,
    noticeHash: noticeHash(),
    consentedAt: new Date().toISOString(),
  };
  writePrivateJson(jevConsentPath(config), consent);
  return consent;
}

export function disableJev(config: HistoryConfig): JevConsent {
  const prior = readJevConsent(config);
  const consent: JevConsent = {
    schemaVersion: JEV_CONSENT_VERSION,
    enabled: false,
    noticeVersion: JEV_CONSENT_VERSION,
    noticeHash: noticeHash(),
    consentedAt: prior?.consentedAt,
    disabledAt: new Date().toISOString(),
  };
  writePrivateJson(jevConsentPath(config), consent);
  return consent;
}

function isChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is ChoiceAnswer<T> {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<ChoiceAnswer<T>>;
  if (
    answer.type !== "choice" ||
    !allowed.includes(answer.choice as T) ||
    typeof answer.confidence !== "number" ||
    answer.confidence < 0 ||
    answer.confidence > 1 ||
    !answer.probabilities ||
    typeof answer.probabilities !== "object"
  )
    return false;
  let sum = 0;
  for (const option of allowed) {
    const probability = answer.probabilities[option];
    if (typeof probability !== "number" || probability < 0 || probability > 1) return false;
    sum += probability;
  }
  return Math.abs(sum - 1) <= 0.02;
}

function isNoul(value: unknown): value is NoulAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<NoulAnswer>;
  return (
    answer.type === "noul" &&
    typeof answer.noul === "number" &&
    answer.noul >= 0 &&
    answer.noul <= 1
  );
}

export function readJevFeedback(config: HistoryConfig): JevFeedbackRecord[] {
  if (!config.enabled) return [];
  try {
    return fs
      .readFileSync(jevFeedbackPath(config), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line: string) => {
        try {
          const value = JSON.parse(line) as JevFeedbackRecord;
          return isJevFeedbackRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function isJevFeedbackRecord(value: unknown): value is JevFeedbackRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<JevFeedbackRecord>;
  const agents = ["claude", "codex", "gemini", "copilot"] as const;
  const tiers = ["fast", "balanced", "deep"] as const;
  return Boolean(
    record.schemaVersion === JEV_FEEDBACK_SCHEMA_VERSION &&
    typeof record.id === "string" &&
    typeof record.timestamp === "string" &&
    typeof record.sourceHistoryId === "string" &&
    typeof record.runId === "string" &&
    record.taskFeatures &&
    Array.isArray(record.taskFeatures.embedding) &&
    record.selected &&
    agents.includes(record.selected.agent) &&
    tiers.includes(record.selected.tier) &&
    record.suggested &&
    agents.includes(record.suggested.agent) &&
    tiers.includes(record.suggested.tier) &&
    typeof record.model === "string" &&
    typeof record.questionSetVersion === "string" &&
    isChoice(record.provider, agents) &&
    isChoice(record.tier, tiers) &&
    isNoul(record.decisionAppropriate) &&
    typeof record.acceptedIntoLearning === "boolean" &&
    typeof record.acceptanceReason === "string",
  );
}

function appendJevFeedback(config: HistoryConfig, records: JevFeedbackRecord[]): void {
  if (!records.length) return;
  const file = jevFeedbackPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(`${file}.lock`, () => {
    fs.appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(file, 0o600);
  });
}

export function resetJevFeedback(config: HistoryConfig): number {
  const file = jevFeedbackPath(config);
  return withFileLock(`${file}.lock`, () => {
    const records = readJevFeedback(config);
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return records.length;
  });
}

function bucket(value: number | undefined, boundaries: number[]): string | undefined {
  if (value === undefined) return undefined;
  const index = boundaries.findIndex((boundary) => value <= boundary);
  return index < 0 ? `>${boundaries.at(-1)}` : `<=${boundaries[index]}`;
}

function runPayload(config: HistoryConfig, records: HistoryRecord[]) {
  const explicit = readFeedbackForRun(config, records);
  return {
    task: records[0].originalTask ?? records[0].task,
    phases: records.map((record) => ({
      phase: record.phaseKind ?? "single",
      task_features: {
        category: record.taskFeatures?.category,
        language: record.taskFeatures?.language,
        risk: record.taskFeatures?.risk,
        complexity: record.complexity,
      },
      selected_route: { provider: record.agent, tier: record.modelTier },
      outcome: {
        completion: record.outcome?.completion ?? (record.exitCode === 0 ? 1 : 0),
        verification: record.outcome?.verification,
        retries: record.outcome?.retries,
        recoveries: record.outcome?.recoveries,
        regressions: record.outcome?.regressions,
        duration_bucket_ms: bucket(record.durationMs, [1_000, 10_000, 60_000, 300_000]),
        token_bucket: bucket(record.outcome?.tokens, [1_000, 10_000, 50_000, 100_000]),
      },
      ...(explicit ? { user_rating: explicit } : {}),
    })),
  };
}

function readFeedbackForRun(
  config: HistoryConfig,
  records: HistoryRecord[],
): "good" | "bad" | undefined {
  const ids = new Set(records.map((record) => record.id));
  const runIds = new Set(records.map((record) => record.runId ?? record.id));
  return readFeedback(config)
    .filter(
      (item) =>
        item.source === "explicit" &&
        ((item.scope === "phase" && ids.has(item.targetId)) ||
          (item.scope === "run" && runIds.has(item.targetId))),
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .at(-1)?.rating;
}

function questions(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      [
        `provider_${index}`,
        {
          type: "choice",
          instructions: `Which registered capability profile best fits the task represented by \`phases[${index}]\`?`,
          criteria: {
            claude: "Investigation, research, review, architecture, and high-risk work",
            codex: "Implementation, tests, debugging, and scoped engineering work",
            gemini: "Research, review, and complex information synthesis",
            copilot: "Scoped implementation, tests, and review assistance",
          },
        },
      ],
      [
        `tier_${index}`,
        {
          type: "choice",
          instructions: `Which reasoning tier is proportionate for \`phases[${index}]\`?`,
          criteria: {
            fast: "Routine, localized, and low uncertainty",
            balanced: "Moderate scope or uncertainty",
            deep: "Complex, risky, cross-cutting, or investigation-heavy",
          },
        },
      ],
      [
        `appropriate_${index}`,
        {
          type: "noul",
          instructions: `Is \`phases[${index}].selected_route\` proportionate and semantically appropriate for this phase?`,
          criteria: {
            true: "The provider profile fits and the tier is neither insufficient nor excessive",
            false: "The provider profile is a poor fit or the tier is materially wrong",
          },
        },
      ],
    ]).flat(),
  );
}

function acceptance(
  record: HistoryRecord,
  provider: ChoiceAnswer<Agent>,
  tier: ChoiceAnswer<ModelTier>,
  appropriate: NoulAnswer,
): { accepted: boolean; reason: string } {
  if (provider.confidence < 0.7 || tier.confidence < 0.7)
    return { accepted: false, reason: "confidence below 0.70" };
  const agrees = provider.choice === record.agent && tier.choice === record.modelTier;
  if (appropriate.noul >= 0.65 && agrees)
    return { accepted: true, reason: "high-confidence reinforcement" };
  if (appropriate.noul <= 0.35 && !agrees)
    return { accepted: true, reason: "high-confidence correction" };
  return { accepted: false, reason: "ambiguous or internally inconsistent judgment" };
}

export async function evaluateRunWithJev(
  config: HistoryConfig,
  runId: string,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    endpoint?: string;
  } = {},
): Promise<JevEvaluationResult> {
  if (!isJevEnabled(config)) return { status: "skipped", reason: "Jev feedback is disabled" };
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { status: "skipped", reason: "TYPESAFE_API_KEY is not set" };
  const completed = new Set(readJevFeedback(config).map((record) => record.sourceHistoryId));
  const records = readHistory(config).filter(
    (record) => (record.runId ?? record.id) === runId && !completed.has(record.id),
  );
  if (!records.length) return { status: "skipped", reason: "No unevaluated history for this run" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const state = runPayload(config, records);
    const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: questions(records.length) }),
      signal: controller.signal,
    });
    if (!response.ok) return { status: "error", reason: `Jev request failed (${response.status})` };
    const result = (await response.json()) as {
      model?: unknown;
      answers?: Record<string, unknown>;
    };
    if (result.model !== JEV_MODEL)
      return { status: "error", reason: "Jev returned an unexpected model version" };
    if (!result.answers || typeof result.answers !== "object")
      return { status: "error", reason: "Jev returned malformed answers" };

    const stored: JevFeedbackRecord[] = [];
    for (const [index, record] of records.entries()) {
      const provider = result.answers[`provider_${index}`];
      const tier = result.answers[`tier_${index}`];
      const appropriate = result.answers[`appropriate_${index}`];
      if (
        !isChoice(provider, ["claude", "codex", "gemini", "copilot"] as const) ||
        !isChoice(tier, ["fast", "balanced", "deep"] as const) ||
        !isNoul(appropriate)
      )
        return { status: "error", reason: "Jev returned malformed typed answers" };
      const accepted = acceptance(record, provider, tier, appropriate);
      stored.push({
        schemaVersion: JEV_FEEDBACK_SCHEMA_VERSION,
        id: newHistoryId(),
        timestamp: new Date().toISOString(),
        sourceHistoryId: record.id,
        runId,
        repositoryId: record.repositoryId,
        taskFeatures:
          record.taskFeatures ??
          extractTaskFeatures(record.originalTask ?? record.task, record.complexity),
        selected: { agent: record.agent, tier: record.modelTier },
        suggested: { agent: provider.choice, tier: tier.choice },
        model: JEV_MODEL,
        questionSetVersion: JEV_QUESTION_SET_VERSION,
        provider,
        tier,
        decisionAppropriate: appropriate,
        acceptedIntoLearning: accepted.accepted,
        acceptanceReason: accepted.reason,
      });
    }
    appendJevFeedback(config, stored);
    return { status: "saved", records: stored };
  } catch (error) {
    return {
      status: "error",
      reason:
        error instanceof Error && error.name === "AbortError"
          ? "Jev request timed out"
          : "Jev request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function featureSimilarity(a: TaskFeatures, b: TaskFeatures): number {
  const dot = a.embedding.reduce((sum, value, index) => sum + value * (b.embedding[index] ?? 0), 0);
  let score = Math.max(0, dot) * 0.8;
  if (a.category === b.category) score += 0.1;
  if (a.risk === b.risk) score += 0.05;
  if (a.language && a.language === b.language) score += 0.05;
  return Math.min(1, score);
}

export function jevLearningHints(task: string, config: HistoryConfig): JevLearningHint {
  const empty: JevLearningHint = {
    agentBoosts: { claude: 0, codex: 0, gemini: 0, copilot: 0 },
    tierBoosts: { fast: 0, balanced: 0, deep: 0 },
    observations: 0,
    confidence: 0,
    notes: [],
  };
  if (!config.learningEnabled || !isJevEnabled(config)) return empty;
  const target = extractTaskFeatures(task);
  const repositoryId = config.repositoryScoped
    ? resolveRepositoryIdentity(process.cwd(), path.dirname(historyPath(config))).id
    : undefined;
  const now = Date.now();
  const halfLifeMs = Math.max(1, config.halfLifeDays ?? 90) * 86_400_000;
  const matches = readJevFeedback(config).flatMap((record) => {
    if (!record.acceptedIntoLearning) return [];
    if (repositoryId && record.repositoryId !== repositoryId) return [];
    const similarity = featureSimilarity(target, record.taskFeatures);
    if (similarity < config.similarityThreshold) return [];
    const age = Math.max(0, now - Date.parse(record.timestamp));
    const decay = 2 ** (-age / halfLifeMs);
    const confidence = Math.min(record.provider.confidence, record.tier.confidence);
    return [{ record, weight: similarity * decay * confidence }];
  });
  const samples = matches.reduce((sum, match) => sum + match.weight, 0);
  if (samples < (config.minimumSamples ?? 2)) return empty;
  for (const { record, weight } of matches) {
    empty.agentBoosts[record.suggested.agent] += weight;
    empty.tierBoosts[record.suggested.tier] += weight;
  }
  for (const agent of Object.keys(empty.agentBoosts) as Agent[])
    empty.agentBoosts[agent] = Math.min(1.25, (empty.agentBoosts[agent] / samples) * 1.25);
  for (const tier of Object.keys(empty.tierBoosts) as ModelTier[])
    empty.tierBoosts[tier] = Math.min(0.75, empty.tierBoosts[tier] / samples);
  empty.observations = matches.length;
  empty.confidence = Math.min(1, samples / Math.max(1, config.minimumSamples ?? 2));
  empty.notes.push(`${matches.length} similar consented Jev judgment(s) supplied a bounded hint`);
  return empty;
}
